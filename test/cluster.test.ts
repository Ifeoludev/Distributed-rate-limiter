import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashRing } from "../src/ring/hashRing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../src/node/server.ts");
// Running tsx's CLI entry via `node` directly (instead of `npx tsx`) avoids
// spawning a shell, which on Windows mangles the path to this repo (it has
// spaces) because shell:true only concatenates args instead of escaping them.
const tsxCli = resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");

type Instance = { id: string; port: number; child: ChildProcess };
type Decision = { allowed: boolean; remaining: number; retryAfterMs: number };

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        rej(new Error("could not allocate a free port"));
        return;
      }
      probe.close(() => res(address.port));
    });
  });
}

async function waitForHealth(port: number, stderr: string[], deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // instance not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`instance on port ${port} never became healthy:\n${stderr.join("")}`);
}

async function startInstance(
  id: string,
  port: number,
  peers: string,
  mode: "strict" | "lease",
): Promise<Instance> {
  const stderr: string[] = [];
  const child = spawn(process.execPath, [tsxCli, serverPath], {
    env: {
      ...process.env,
      NODE_ID: id,
      PORT: String(port),
      PEERS: peers,
      CAPACITY: "100",
      // Kept slow on purpose: this suite hits real instances over real HTTP,
      // so a fast refill would let the burst's own wall-clock duration admit
      // extra tokens (see DESIGN.md's Option A note) and make the assertion flaky.
      REFILL_PER_SEC: "1",
      FAIL_MODE: "closed",
      FORWARD_TIMEOUT_MS: "2000",
      MODE: mode,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  await waitForHealth(port, stderr);
  return { id, port, child };
}

async function post<T>(instance: Instance, path: string, key: string): Promise<T> {
  const res = await fetch(`http://localhost:${instance.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return (await res.json()) as T;
}

function check(instance: Instance, path: string, key: string): Promise<Decision> {
  return post<Decision>(instance, path, key);
}

async function startCluster(mode: "strict" | "lease"): Promise<Instance[]> {
  const ids = ["a", "b", "c"];
  const ports = await Promise.all(ids.map(() => freePort()));
  const peers = ids.map((id, i) => `${id}=localhost:${ports[i]}`).join(",");
  return Promise.all(ids.map((id, i) => startInstance(id, ports[i]!, peers, mode)));
}

// Fired concurrently so refill (1/sec here) during the burst is negligible.
async function burst(instances: Instance[], key: string, count: number): Promise<Map<string, number>> {
  const decisions = await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const instance = instances[i % instances.length]!;
      return check(instance, "/check", key).then((d) => ({ id: instance.id, allowed: d.allowed }));
    }),
  );
  const admittedById = new Map<string, number>();
  for (const d of decisions) {
    if (d.allowed) admittedById.set(d.id, (admittedById.get(d.id) ?? 0) + 1);
  }
  return admittedById;
}

function total(admittedById: Map<string, number>): number {
  return [...admittedById.values()].reduce((a, b) => a + b, 0);
}

describe("cluster forwarding (strict mode)", () => {
  let instances: Instance[] = [];

  beforeAll(async () => {
    instances = await startCluster("strict");
  }, 20_000);

  afterAll(() => {
    for (const instance of instances) instance.child.kill();
  });

  it("shares one bucket for a key across the whole cluster, however the request arrives", async () => {
    const key = `burst-${Math.random()}`;
    const capacity = 100;

    // More requests than capacity, round-robined across all three instances.
    const admitted = total(await burst(instances, key, capacity + 50));
    expect(admitted).toBeLessThanOrEqual(capacity);
    expect(admitted).toBeGreaterThan(capacity - 3); // small margin for refill during the burst
  });

  it("never forwards a request received on /internal/check, even for a key it doesn't own", async () => {
    const ring = new HashRing(instances.map((i) => i.id));
    const key = `internal-${Math.random()}`;
    const ownerId = ring.getOwner(key);
    const nonOwner = instances.find((i) => i.id !== ownerId)!;
    const owner = instances.find((i) => i.id === ownerId)!;

    // Exhaust the key's bucket by calling /internal/check directly on the
    // non-owner, bypassing the ownership routing that /check would apply.
    for (let i = 0; i < 100; i++) {
      await check(nonOwner, "/internal/check", key);
    }
    const blockedOnNonOwner = await check(nonOwner, "/internal/check", key);
    expect(blockedOnNonOwner.allowed).toBe(false);

    // If /internal/check had forwarded to the real owner, its bucket would be
    // exhausted too. It wasn't touched, so /check (routed to the real owner) is fresh.
    const decisionViaCheck = await check(owner, "/check", key);
    expect(decisionViaCheck.allowed).toBe(true);
  });
});

describe("cluster leasing (lease mode)", () => {
  let instances: Instance[] = [];

  beforeAll(async () => {
    instances = await startCluster("lease");
  }, 20_000);

  afterAll(() => {
    for (const instance of instances) instance.child.kill();
  });

  function ownerAndNonOwner(key: string): { owner: Instance; nonOwner: Instance } {
    const ownerId = new HashRing(instances.map((i) => i.id)).getOwner(key);
    return {
      owner: instances.find((i) => i.id === ownerId)!,
      nonOwner: instances.find((i) => i.id !== ownerId)!,
    };
  }

  it("grants leases of 10% of capacity, then partial, then none", async () => {
    const key = `lease-${Math.random()}`;
    const { owner } = ownerAndNonOwner(key);

    for (let i = 0; i < 95; i++) await check(owner, "/internal/check", key);

    const partial = await post<{ granted: number }>(owner, "/internal/lease", key);
    expect(partial.granted).toBe(5);
    const none = await post<{ granted: number; retryAfterMs: number }>(owner, "/internal/lease", key);
    expect(none.granted).toBe(0);
    expect(none.retryAfterMs).toBeGreaterThan(0);
  });

  it("decides locally from a lease without asking the owner", async () => {
    const key = `local-${Math.random()}`;
    const { owner, nonOwner } = ownerAndNonOwner(key);

    expect((await check(nonOwner, "/check", key)).allowed).toBe(true); // takes a lease of 10
    // Drain the owner's bucket directly. A non-owner still asking the owner
    // per request would now be denied.
    for (let i = 0; i < 100; i++) await check(owner, "/internal/check", key);

    expect((await check(nonOwner, "/check", key)).allowed).toBe(true);
  });

  it("stays within the limit and admits on every instance, not just the owner", async () => {
    const key = `burst-${Math.random()}`;
    const capacity = 100;

    const admittedById = await burst(instances, key, capacity + 50);

    expect(total(admittedById)).toBeLessThanOrEqual(capacity);
    for (const instance of instances) {
      expect(admittedById.get(instance.id) ?? 0).toBeGreaterThan(0);
    }
  });
});
