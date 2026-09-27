import type { HashRing } from "../ring/hashRing.js";
import type { Config, PeerAddress } from "./config.js";

// Counts consecutive misses per peer. Every peer starts alive, matching the
// ring, which is built from the full PEERS list.
export class PeerHealth {
  private readonly misses = new Map<string, number>();
  private readonly removed = new Set<string>();

  constructor(private readonly missesToRemove: number) {}

  record(peerId: string, ok: boolean): "removed" | "rejoined" | null {
    if (ok) {
      this.misses.set(peerId, 0);
      if (!this.removed.delete(peerId)) return null;
      return "rejoined";
    }
    const misses = (this.misses.get(peerId) ?? 0) + 1;
    this.misses.set(peerId, misses);
    if (misses < this.missesToRemove || this.removed.has(peerId)) return null;
    this.removed.add(peerId);
    return "removed";
  }
}

async function isHealthy(
  peer: PeerAddress,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetch(`http://${peer.host}:${peer.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function startHealthChecks(config: Config, ring: HashRing): void {
  const health = new PeerHealth(config.healthMisses);
  const others = [...config.peers].filter(([id]) => id !== config.nodeId);

  // Scheduled after each round finishes rather than with setInterval, so a
  // round of slow checks can't overlap the next one.
  const round = async (): Promise<void> => {
    await Promise.all(
      others.map(async ([id, address]) => {
        const ok = await isHealthy(address, config.forwardTimeoutMs);
        const change = health.record(id, ok);
        if (change === "removed") ring.removeInstance(id);
        if (change === "rejoined") ring.addInstance(id);
        if (change) {
          console.log(`instance ${config.nodeId}: peer ${id} ${change}`);
        }
      }),
    );
    setTimeout(() => void round(), config.healthIntervalMs);
  };
  setTimeout(() => void round(), config.healthIntervalMs);
}
