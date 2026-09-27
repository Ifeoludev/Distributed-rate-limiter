import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { HashRing } from "../ring/hashRing.js";
import { TokenBucketLimiter, type Decision } from "../limiter/tokenBucket.js";
import { loadConfig } from "./config.js";
import { LeaseStore, type LeaseGrant } from "./leases.js";

const config = loadConfig();
const ring = new HashRing([...config.peers.keys()]);
const limiter = new TokenBucketLimiter(
  { capacity: config.capacity, refillPerSec: config.refillPerSec },
  Date.now,
);

type CheckRequest = { key: string; cost?: number };

function parseCheckRequest(body: unknown): CheckRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("request body must be a JSON object");
  }
  const { key, cost } = body as Record<string, unknown>;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("key must be a non-empty string");
  }
  if (cost === undefined) return { key };
  if (
    typeof cost !== "number" ||
    !Number.isInteger(cost) ||
    cost < 1 ||
    cost > config.capacity
  ) {
    throw new Error(`cost must be an integer between 1 and ${config.capacity}`);
  }
  return { key, cost };
}

function failModeDecision(): Decision {
  if (config.failMode === "open") {
    return { allowed: true, remaining: 0, retryAfterMs: 0 };
  }
  // We don't know the real owner's bucket state, so there's no real wait to report.
  return { allowed: false, remaining: 0, retryAfterMs: 0 };
}

async function forward(peerId: string, body: CheckRequest): Promise<Decision> {
  const peer = config.peers.get(peerId);
  if (!peer) throw new Error(`ring returned unknown peer id: ${peerId}`);

  try {
    const res = await fetch(`http://${peer.host}:${peer.port}/internal/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.forwardTimeoutMs),
    });
    if (!res.ok) throw new Error(`peer ${peerId} responded with ${res.status}`);
    return (await res.json()) as Decision;
  } catch {
    return failModeDecision();
  }
}

async function requestLease(key: string): Promise<LeaseGrant> {
  const owner = ring.getOwner(key);
  const peer = config.peers.get(owner);
  if (!peer) throw new Error(`ring returned unknown peer id: ${owner}`);

  const res = await fetch(`http://${peer.host}:${peer.port}/internal/lease`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(config.forwardTimeoutMs),
  });
  if (!res.ok) throw new Error(`peer ${owner} responded with ${res.status}`);
  return (await res.json()) as LeaseGrant;
}

const leases = new LeaseStore(
  requestLease,
  config.leaseSize,
  config.leasePrefetch,
  Date.now,
);

// `remaining` here is what is left of this instance's lease, not the owner's bucket.
async function handleLeasedCheck(
  owner: string,
  body: CheckRequest,
): Promise<Decision> {
  const cost = body.cost ?? 1;
  // A lease never holds more than leaseSize tokens, so it could never cover this.
  if (cost > config.leaseSize) return forward(owner, body);

  let remaining = leases.spend(body.key, cost);
  if (remaining === null) {
    let grant: LeaseGrant;
    try {
      grant = await leases.refill(body.key);
    } catch {
      return failModeDecision();
    }
    remaining = leases.spend(body.key, cost);
    // Other requests waiting on the same lease may have spent it first.
    if (remaining === null) {
      return { allowed: false, remaining: 0, retryAfterMs: grant.retryAfterMs };
    }
  }

  if (leases.isLow(body.key)) {
    // A failed prefetch is harmless: the next request that finds the lease
    // empty asks the owner again and applies FAIL_MODE if that fails too.
    leases.refill(body.key).catch(() => {});
  }
  return { allowed: true, remaining, retryAfterMs: 0 };
}

async function handleCheck(body: CheckRequest): Promise<Decision> {
  const owner = ring.getOwner(body.key);
  if (owner === config.nodeId) return limiter.allow(body.key, body.cost);
  if (config.mode === "lease") return handleLeasedCheck(owner, body);
  return forward(owner, body);
}

function handleInternalCheck(body: CheckRequest): Decision {
  return limiter.allow(body.key, body.cost);
}

function handleInternalLease(body: CheckRequest): LeaseGrant {
  return {
    ...limiter.take(body.key, config.leaseSize),
    durationMs: config.leaseDurationMs,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (
    req.method === "POST" &&
    (req.url === "/check" ||
      req.url === "/internal/check" ||
      req.url === "/internal/lease")
  ) {
    let parsed: CheckRequest;
    try {
      parsed = parseCheckRequest(JSON.parse(await readBody(req)));
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : "invalid request",
      });
      return;
    }

    if (req.url === "/internal/lease") {
      sendJson(res, 200, handleInternalLease(parsed));
      return;
    }
    const decision =
      req.url === "/check"
        ? await handleCheck(parsed)
        : handleInternalCheck(parsed);
    sendJson(res, 200, decision);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  void route(req, res);
});

server.listen(config.port, () => {
  console.log(
    `instance ${config.nodeId} listening on ${config.port} (${config.mode} mode)`,
  );
});
