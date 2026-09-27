import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Turns faults.ts's CSVs into hand-built SVG graphs and a summary table.

type Row = {
  tMs: number;
  key: string;
  allowed: boolean;
  latencyMs: number;
  error: string;
};
type Series = { name: string; color: string; points: number[]; dashed?: boolean };
type Marker = { tMs: number; label: string };

const WINDOW_MS = 1000;
const LIMIT_PER_SEC = 100;
const HEAVY_KEY = "heavy";
const PHASES = [
  { name: "0-10s before kill", fromMs: 0, toMs: 10_000 },
  { name: "10-20s owner dead", fromMs: 10_000, toMs: 20_000 },
  { name: "20-30s after restart", fromMs: 20_000, toMs: 30_000 },
  { name: "0-30s whole run", fromMs: 0, toMs: 30_000 },
];
const RUNS = [1, 2, 3];
const RUN_COLORS = ["#1e40af", "#3b82f6", "#93c5fd"];
const DURATION_MS = 30_000;

// Nearest-rank percentile: always one of the observed values, never an
// interpolation between two of them.
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!; // rank is within 1..length
}

export function countPerWindow(
  timesMs: readonly number[],
  windowMs: number,
  durationMs: number,
): number[] {
  const counts = new Array<number>(Math.ceil(durationMs / windowMs)).fill(0);
  for (const t of timesMs) {
    const i = Math.floor(t / windowMs);
    if (i >= 0 && i < counts.length) counts[i]! += 1; // bounds checked above
  }
  return counts;
}

function readRows(path: string): Row[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [tMs, key, , allowed, latencyMs, error] = line.split(",");
      return {
        tMs: Number(tMs),
        key: key ?? "",
        allowed: allowed === "1",
        latencyMs: Number(latencyMs),
        error: error ?? "",
      };
    });
}

function readMarkers(path: string): Marker[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [tMs, label] = line.split(",");
      return { tMs: Number(tMs), label: label ?? "" };
    });
}

function latencyPerWindow(rows: readonly Row[], p: number): number[] {
  const buckets = Array.from(
    { length: Math.ceil(DURATION_MS / WINDOW_MS) },
    () => [] as number[],
  );
  for (const r of rows) {
    if (r.error) continue;
    buckets[Math.floor(r.tMs / WINDOW_MS)]?.push(r.latencyMs);
  }
  return buckets.map((b) => percentile(b, p));
}

function niceMax(value: number): number {
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

function lineChart(
  title: string,
  yLabel: string,
  series: readonly Series[],
  markers: readonly Marker[],
): string {
  const width = 760;
  const height = 360;
  const left = 60;
  const right = 20;
  const top = 40;
  const bottom = 80;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const finite = series.flatMap((s) => s.points).filter(Number.isFinite);
  const yMax = niceMax(Math.max(1, ...finite));
  // Each value is plotted at the middle of the window it summarises.
  const x = (tMs: number) => left + (tMs / DURATION_MS) * plotW;
  const y = (v: number) => top + plotH - (v / yMax) * plotH;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif" font-size="12">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${width / 2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">${title}</text>`,
  ];
  for (let i = 0; i <= 5; i++) {
    const v = (yMax / 5) * i;
    parts.push(
      `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e5e5"/>`,
      `<text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`,
    );
  }
  for (let s = 0; s <= DURATION_MS / 1000; s += 5) {
    parts.push(
      `<text x="${x(s * 1000)}" y="${top + plotH + 16}" text-anchor="middle">${s}s</text>`,
    );
  }
  parts.push(
    `<line x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}" stroke="#333"/>`,
    `<line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="#333"/>`,
    `<text transform="translate(16 ${top + plotH / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>`,
  );
  for (const m of markers) {
    parts.push(
      `<line x1="${x(m.tMs)}" x2="${x(m.tMs)}" y1="${top}" y2="${top + plotH}" stroke="#888" stroke-dasharray="2 3"/>`,
      `<text x="${x(m.tMs) + 4}" y="${top + 12}" fill="#555">${m.label}</text>`,
    );
  }
  for (const s of series) {
    const d = s.points
      .map((v, i) => [x((i + 0.5) * WINDOW_MS), v] as const)
      .filter(([, v]) => Number.isFinite(v))
      .map(([px, v], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");
    const dash = s.dashed ? ` stroke-dasharray="6 4"` : "";
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${dash}/>`);
  }
  series.forEach((s, i) => {
    const lx = left + i * 180;
    const ly = height - 24;
    const dash = s.dashed ? ` stroke-dasharray="6 4"` : "";
    parts.push(
      `<line x1="${lx}" x2="${lx + 24}" y1="${ly}" y2="${ly}" stroke="${s.color}" stroke-width="2"${dash}/>`,
      `<text x="${lx + 30}" y="${ly + 4}">${s.name}</text>`,
    );
  });
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}

function main(): void {
  const resultsDir = resolve(dirname(fileURLToPath(import.meta.url)), "results");
  const scenarios = ["strict-open", "strict-closed", "lease-open", "lease-closed"];
  const windows = Math.ceil(DURATION_MS / WINDOW_MS);
  const summary = [
    "scenario,run,phase,heavyAdmitted,heavyAdmittedPerSec,heavyMaxAdmittedIn1s,lightAllowedPctOfAnswered,errors,p50Ms,p99Ms",
  ];
  const pooledRows = new Map<string, Row[]>();

  for (const name of scenarios) {
    const series: Series[] = [];
    let errors: number[] = [];
    let markers: Marker[] = [];
    const pooled: Row[] = [];

    for (const run of RUNS) {
      const file = `${name}-run${run}`;
      const rows = readRows(resolve(resultsDir, `${file}.csv`));
      pooled.push(...rows);
      const heavy = rows.filter((r) => r.key === HEAVY_KEY);
      const admitted = countPerWindow(
        heavy.filter((r) => r.allowed).map((r) => r.tMs),
        WINDOW_MS,
        DURATION_MS,
      );
      series.push({
        name: `admitted, run ${run}`,
        color: RUN_COLORS[run - 1] ?? "#2563eb",
        points: admitted,
      });
      // Kill and restart land within a few ms of the same time in every run,
      // so one run's errors and markers stand for all of them.
      if (run === 1) {
        errors = countPerWindow(
          heavy.filter((r) => r.error).map((r) => r.tMs),
          WINDOW_MS,
          DURATION_MS,
        );
        markers = readMarkers(resolve(resultsDir, `${file}-events.csv`));
      }

      for (const phase of PHASES) {
        const inPhase = rows.filter((r) => r.tMs >= phase.fromMs && r.tMs < phase.toMs);
        const heavyAdmitted = inPhase.filter((r) => r.key === HEAVY_KEY && r.allowed).length;
        // Requests that hit the dead instance are counted under errors, not
        // here, so this measures only what the limiter decided.
        const light = inPhase.filter((r) => r.key !== HEAVY_KEY && !r.error);
        const seconds = (phase.toMs - phase.fromMs) / 1000;
        const ok = inPhase.filter((r) => !r.error).map((r) => r.latencyMs);
        summary.push(
          [
            name,
            run,
            phase.name,
            heavyAdmitted,
            (heavyAdmitted / seconds).toFixed(1),
            Math.max(...admitted.slice(phase.fromMs / WINDOW_MS, phase.toMs / WINDOW_MS)),
            ((100 * light.filter((r) => r.allowed).length) / light.length).toFixed(1),
            inPhase.filter((r) => r.error).length,
            percentile(ok, 50).toFixed(2),
            percentile(ok, 99).toFixed(2),
          ].join(","),
        );
      }
    }
    pooledRows.set(name, pooled);

    writeFileSync(
      resolve(resultsDir, `${name}-admitted.svg`),
      lineChart(
        `Heavy key admitted per second (${name}), sent at 300/s`,
        "requests per second",
        [
          ...series,
          { name: "errors (run 1)", color: "#dc2626", points: errors },
          {
            name: `limit (${LIMIT_PER_SEC}/s)`,
            color: "#111111",
            points: new Array<number>(windows).fill(LIMIT_PER_SEC),
            dashed: true,
          },
        ],
        markers,
      ),
    );
  }

  for (const failMode of ["open", "closed"]) {
    const strict = pooledRows.get(`strict-${failMode}`) ?? [];
    const lease = pooledRows.get(`lease-${failMode}`) ?? [];
    writeFileSync(
      resolve(resultsDir, `latency-${failMode}.svg`),
      lineChart(
        `/check latency per second, strict vs lease (FAIL_MODE=${failMode}, ${RUNS.length} runs pooled)`,
        "latency (ms)",
        [
          { name: "strict p50", color: "#2563eb", points: latencyPerWindow(strict, 50) },
          { name: "strict p99", color: "#2563eb", points: latencyPerWindow(strict, 99), dashed: true },
          { name: "lease p50", color: "#ea580c", points: latencyPerWindow(lease, 50) },
          { name: "lease p99", color: "#ea580c", points: latencyPerWindow(lease, 99), dashed: true },
        ],
        [
          { tMs: 10_000, label: "owner killed" },
          { tMs: 20_000, label: "owner restarted" },
        ],
      ),
    );
  }

  writeFileSync(resolve(resultsDir, "summary.csv"), summary.join("\n") + "\n");
}

// Only run when invoked directly, so the test can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
