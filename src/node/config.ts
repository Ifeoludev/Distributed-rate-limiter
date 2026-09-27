export type PeerAddress = { host: string; port: number };

export type Config = {
  nodeId: string;
  port: number;
  peers: Map<string, PeerAddress>; // includes this instance's own entry
  capacity: number;
  refillPerSec: number;
  failMode: "open" | "closed";
  forwardTimeoutMs: number;
  mode: "strict" | "lease";
  leaseSize: number;
  leaseDurationMs: number;
  leasePrefetch: number; // fraction of a lease left that triggers the next request
  healthIntervalMs: number;
  healthMisses: number; // consecutive failed checks before a peer leaves the ring
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function parsePort(raw: string, name: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid port number, got: ${raw}`);
  }
  return port;
}

function parsePositiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return value;
}

function parsePeers(raw: string): Map<string, PeerAddress> {
  const peers = new Map<string, PeerAddress>();
  for (const entry of raw.split(",")) {
    const [id, address] = entry.split("=");
    const [host, portStr] = address?.split(":") ?? [];
    if (!id || !host || !portStr) {
      throw new Error(
        `PEERS entry "${entry}" is malformed, expected id=host:port`,
      );
    }
    peers.set(id, { host, port: parsePort(portStr, `PEERS entry "${entry}"`) });
  }
  return peers;
}

function parseFailMode(raw: string): "open" | "closed" {
  if (raw !== "open" && raw !== "closed") {
    throw new Error(`FAIL_MODE must be "open" or "closed", got: ${raw}`);
  }
  return raw;
}

function parseMode(raw: string): "strict" | "lease" {
  if (raw !== "strict" && raw !== "lease") {
    throw new Error(`MODE must be "strict" or "lease", got: ${raw}`);
  }
  return raw;
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function parseFraction(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1, got: ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeId = required(env, "NODE_ID");
  const port = parsePort(required(env, "PORT"), "PORT");
  const peers = parsePeers(required(env, "PEERS"));
  if (!peers.has(nodeId)) {
    throw new Error(
      `PEERS has no entry for this instance's NODE_ID (${nodeId})`,
    );
  }

  // Capacity 100 / refill 100 per second is "Option A" from the design doc:
  // a quiet client can burst 100 at once, then settles at 100/sec.
  const capacity = env.CAPACITY
    ? parsePositiveNumber(env.CAPACITY, "CAPACITY")
    : 100;
  const refillPerSec = env.REFILL_PER_SEC
    ? parsePositiveNumber(env.REFILL_PER_SEC, "REFILL_PER_SEC")
    : 100;
  const failMode = parseFailMode(required(env, "FAIL_MODE"));
  // 50ms is the example value from the design doc's config block.
  const forwardTimeoutMs = env.FORWARD_TIMEOUT_MS
    ? parsePositiveNumber(env.FORWARD_TIMEOUT_MS, "FORWARD_TIMEOUT_MS")
    : 50;

  const mode = env.MODE ? parseMode(env.MODE) : "strict";
  // Lease defaults are the design doc's Refinement values: 10% of capacity,
  // about 1 second, prefetch at 20% left.
  const leaseSize = env.LEASE_SIZE
    ? parsePositiveInteger(env.LEASE_SIZE, "LEASE_SIZE")
    : Math.ceil(capacity * 0.1);
  const leaseDurationMs = env.LEASE_DURATION_MS
    ? parsePositiveNumber(env.LEASE_DURATION_MS, "LEASE_DURATION_MS")
    : 1000;
  const leasePrefetch = env.LEASE_PREFETCH
    ? parseFraction(env.LEASE_PREFETCH, "LEASE_PREFETCH")
    : 0.2;

  // Health defaults are the design doc's Refinement values: a dead peer
  // leaves the ring after about 1.5s, and one slow reply doesn't evict it.
  const healthIntervalMs = env.HEALTH_INTERVAL_MS
    ? parsePositiveNumber(env.HEALTH_INTERVAL_MS, "HEALTH_INTERVAL_MS")
    : 500;
  const healthMisses = env.HEALTH_MISSES
    ? parsePositiveInteger(env.HEALTH_MISSES, "HEALTH_MISSES")
    : 3;

  return {
    nodeId,
    port,
    peers,
    capacity,
    refillPerSec,
    failMode,
    forwardTimeoutMs,
    mode,
    leaseSize,
    leaseDurationMs,
    leasePrefetch,
    healthIntervalMs,
    healthMisses,
  };
}
