import { Agent, request } from "node:http";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Usage (faults.ts sets these): TARGETS=3001,3002 LOAD=heavy:300,light-1:10
// DURATION_MS=30000 WARMUP_LOAD=warmup-1:60 WARMUP_MS=2000 OUT=results.csv
// tsx bench/loadgen.ts
// Prints "started" once the recorded run begins, so the parent can line up its
// fault timeline with this process's t=0.

type Row = {
  tMs: number;
  key: string;
  port: number;
  allowed: boolean;
  latencyMs: number;
  error: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

type Stream = { key: string; intervalMs: number; nextMs: number };

function parseLoad(name: string): Stream[] {
  return requiredEnv(name)
    .split(",")
    .map((entry) => {
      const [key, rate] = entry.split(":");
      if (!key || !rate) {
        throw new Error(`${name} entry "${entry}" must be key:ratePerSec`);
      }
      return { key, intervalMs: 1000 / Number(rate), nextMs: 0 };
    });
}

const targets = requiredEnv("TARGETS").split(",").map(Number);
const load = parseLoad("LOAD");
const durationMs = Number(requiredEnv("DURATION_MS"));
// Warm-up uses its own keys, so the recorded keys still start with full
// buckets (the first-second burst is a result) while process startup, JIT and
// first connections happen before t=0 instead of inflating p99.
const warmupLoad = parseLoad("WARMUP_LOAD");
const warmupMs = Number(requiredEnv("WARMUP_MS"));
const out = requiredEnv("OUT");

// Without keep-alive every request pays TCP setup, and p50/p99 would measure
// that instead of the limiter.
const agent = new Agent({ keepAlive: true, maxSockets: 64 });
const inFlight = new Set<Promise<void>>();
let nextTarget = 0;

function check(port: number, key: string): Promise<{ allowed: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        agent,
        host: "localhost",
        port,
        path: "/check",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as { allowed: boolean });
          } catch {
            reject(new Error("bad-json"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(JSON.stringify({ key }));
  });
}

function send(tMs: number, key: string, rows: Row[]): void {
  // Round-robin like a load balancer in front of the cluster. A dead target
  // is not skipped: its failures are recorded as errors, not hidden.
  // In range: an index modulo the length of TARGETS, which split() never
  // leaves empty.
  const port = targets[nextTarget++ % targets.length]!;
  const sentAt = performance.now();
  const done = check(port, key)
    .then(
      (decision) => {
        const latencyMs = performance.now() - sentAt;
        rows.push({
          tMs,
          key,
          port,
          allowed: decision.allowed,
          latencyMs,
          error: "",
        });
      },
      (err: unknown) => {
        const latencyMs = performance.now() - sentAt;
        const error =
          (err as NodeJS.ErrnoException).code ?? (err as Error).message;
        rows.push({ tMs, key, port, allowed: false, latencyMs, error });
      },
    )
    .finally(() => inFlight.delete(done));
  inFlight.add(done);
}

// Requests are sent at their scheduled times, not as fast as possible. Timer
// ticks are coarse (about 1-16ms depending on the OS), so each tick sends
// everything that has come due; tMs records the scheduled time.
function run(streams: Stream[], durationMs: number, rows: Row[]): Promise<void> {
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      const now = performance.now() - start;
      const until = Math.min(now, durationMs);
      for (const stream of streams) {
        while (stream.nextMs < until) {
          send(stream.nextMs, stream.key, rows);
          stream.nextMs += stream.intervalMs;
        }
      }
      if (now < durationMs) {
        setTimeout(tick, 1);
        return;
      }
      void Promise.all(inFlight).then(() => resolve());
    };
    tick();
  });
}

await run(warmupLoad, warmupMs, []);
const rows: Row[] = [];
console.log("started");
await run(load, durationMs, rows);

rows.sort((a, b) => a.tMs - b.tMs);
const lines = rows.map((r) =>
  [
    r.tMs.toFixed(1),
    r.key,
    r.port,
    r.allowed ? 1 : 0,
    r.latencyMs.toFixed(3),
    r.error,
  ].join(","),
);
const header = "tMs,key,port,allowed,latencyMs,error";
writeFileSync(out, [header, ...lines].join("\n") + "\n");
agent.destroy();
