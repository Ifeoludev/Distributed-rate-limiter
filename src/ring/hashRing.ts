import { createHash } from "node:crypto";

const DEFAULT_VIRTUAL_NODES = 100;

function hash(value: string): number {
  return createHash("sha1").update(value).digest().readUInt32BE(0);
}

type RingEntry = { hash: number; instanceId: string };

export class HashRing {
  private ring: RingEntry[] = [];
  private readonly instanceIds = new Set<string>();

  constructor(
    instanceIds: readonly string[],
    private readonly virtualNodes = DEFAULT_VIRTUAL_NODES,
  ) {
    for (const id of instanceIds) this.addInstance(id);
  }

  addInstance(instanceId: string): void {
    if (this.instanceIds.has(instanceId)) return;
    this.instanceIds.add(instanceId);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({ hash: hash(`${instanceId}#${i}`), instanceId });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeInstance(instanceId: string): void {
    if (!this.instanceIds.has(instanceId)) return;
    this.instanceIds.delete(instanceId);
    this.ring = this.ring.filter((entry) => entry.instanceId !== instanceId);
  }

  getOwner(key: string): string {
    if (this.ring.length === 0) {
      throw new Error("hash ring has no instances");
    }
    const target = hash(key);
    const first = this.ring[0]!; // non-empty, guaranteed by the length check above
    const owner = this.ring.find((entry) => entry.hash >= target) ?? first;
    return owner.instanceId;
  }
}
