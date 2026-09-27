import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// child_process.spawn's `env` option (not inline `VAR=x cmd` shell syntax)
// works the same on PowerShell/cmd and POSIX shells.
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../node/server.ts");
// Running tsx's CLI entry via `node` directly (instead of `npx tsx`) avoids
// spawning a shell, which on Windows mangles paths with spaces because
// shell:true only concatenates args instead of escaping them.
const tsxCli = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");

const INSTANCES = [
  { id: "a", port: 3001 },
  { id: "b", port: 3002 },
  { id: "c", port: 3003 },
];

const peers = INSTANCES.map((i) => `${i.id}=localhost:${i.port}`).join(",");

for (const instance of INSTANCES) {
  const child = spawn(process.execPath, [tsxCli, serverPath], {
    env: {
      ...process.env,
      NODE_ID: instance.id,
      PORT: String(instance.port),
      PEERS: peers,
      CAPACITY: process.env.CAPACITY ?? "100",
      REFILL_PER_SEC: process.env.REFILL_PER_SEC ?? "100",
      FAIL_MODE: process.env.FAIL_MODE ?? "closed",
      MODE: process.env.MODE ?? "strict",
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.log(`instance ${instance.id} exited with code ${code}`);
  });
}
