import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { HashRing } from "../src/ring/hashRing.js";

// Runs every scenario: start 3 instances, run loadgen against them, kill the
// heavy key's owner mid-run, restart it, and save the decisions per scenario.

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../src/node/server.ts");
const loadgenPath = resolve(__dirname, "loadgen.ts");
const resultsDir = resolve(__dirname, "results");
// Running tsx's CLI entry via `node` directly (instead of `npx tsx`) avoids
// spawning a shell, which on Windows mangles paths with spaces.
const tsxCli = resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");

const INSTANCES = [
  { id: "a", port: 3101 },
  { id: "b", port: 3102 },
  { id: "c", port: 3103 },
];
const HEAVY_KEY = "heavy";
// One heavy key at 3x the limit, and light keys well under it that should
// barely notice the heavy one.
const LOAD = [
  `${HEAVY_KEY}:300`,
  ...[1, 2, 3, 4, 5].map((i) => `light-${i}:10`),
].join(",");
// Warm-up keys stay under the limit, so no warm-up request is rejected.
const WARMUP_LOAD = [1, 2, 3, 4, 5].map((i) => `warmup-${i}:60`).join(",");
const WARMUP_MS = 2000;
const DURATION_MS = 30_000;
const KILL_AT_MS = 10_000;
const RESTART_AT_MS = 20_000;
// Each scenario is repeated so results can be reported as a range, not one
// run's luck.
const RUNS = 3;

const peers = INSTANCES.map((i) => `${i.id}=localhost:${i.port}`).join(",");

function startInstance(
  id: string,
  port: number,
  mode: string,
  failMode: string,
): ChildProcess {
  return spawn(process.execPath, [tsxCli, serverPath], {
    env: {
      ...process.env,
      NODE_ID: id,
      PORT: String(port),
      PEERS: peers,
      CAPACITY: "100",
      REFILL_PER_SEC: "100",
      FAIL_MODE: failMode,
      MODE: mode,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`instance on port ${port} never became healthy`);
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill();
  return exited;
}

async function runScenario(
  mode: string,
  failMode: string,
  run: number,
): Promise<void> {
  const name = `${mode}-${failMode}-run${run}`;
  console.log(`scenario ${name}`);
  const children = new Map(
    INSTANCES.map((i) => [i.id, startInstance(i.id, i.port, mode, failMode)]),
  );
  await Promise.all(INSTANCES.map((i) => waitForHealth(i.port)));

  // Same ids, same hash, so this matches the owner every instance computes.
  const victimId = new HashRing(INSTANCES.map((i) => i.id)).getOwner(HEAVY_KEY);
  const victim = INSTANCES.find((i) => i.id === victimId);
  if (!victim) throw new Error(`ring returned unknown instance: ${victimId}`);

  const loadgen = spawn(process.execPath, [tsxCli, loadgenPath], {
    env: {
      ...process.env,
      TARGETS: INSTANCES.map((i) => i.port).join(","),
      LOAD,
      DURATION_MS: String(DURATION_MS),
      WARMUP_LOAD,
      WARMUP_MS: String(WARMUP_MS),
      OUT: resolve(resultsDir, `${name}.csv`),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const loadgenDone = new Promise<void>((r) => loadgen.once("exit", () => r()));
  // loadgen's t=0 is when it prints "started"; fault times are measured from
  // then so both timelines line up.
  const lines = createInterface({ input: loadgen.stdout! }); // stdio "pipe" above
  await new Promise<void>((r) =>
    lines.on("line", (line) => line === "started" && r()),
  );
  const start = performance.now();
  const events: string[] = [];
  const at = (ms: number) =>
    new Promise((r) => setTimeout(r, ms - (performance.now() - start)));
  const record = (event: string) =>
    events.push(`${(performance.now() - start).toFixed(1)},${event}`);

  await at(KILL_AT_MS);
  await stop(children.get(victim.id)!); // every INSTANCES id is in the map
  record(`killed ${victim.id}`);

  await at(RESTART_AT_MS);
  children.set(victim.id, startInstance(victim.id, victim.port, mode, failMode));
  record(`restarting ${victim.id}`);
  await waitForHealth(victim.port);
  record(`healthy ${victim.id}`);

  await loadgenDone;
  await Promise.all([...children.values()].map(stop));
  writeFileSync(
    resolve(resultsDir, `${name}-events.csv`),
    ["tMs,event", ...events].join("\n") + "\n",
  );
}

mkdirSync(resultsDir, { recursive: true });
// Runs are interleaved so slow drift on the machine spreads across all
// scenarios instead of landing on one.
for (let run = 1; run <= RUNS; run++) {
  for (const mode of ["strict", "lease"]) {
    for (const failMode of ["open", "closed"]) {
      await runScenario(mode, failMode, run);
    }
  }
}
