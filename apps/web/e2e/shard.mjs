// Splits the e2e spec files into CI shards by measured duration, not by test count.
//
//   node e2e/shard.mjs 2/3                    prints shard 2 of 3: its spec files, one per line
//   node e2e/shard.mjs --update <report.json>…  rewrites e2e/durations.json from Playwright
//                                                     JSON reports (one per shard of a full run)
//
// Why: Playwright's `--shard` cuts the test list into equal counts in file order, so the shard that
// draws the slow specs (long conversations, catalog imports) ran minutes longer than the others.
// Here each file weighs its seconds in e2e/durations.json (measured against the production build on
// CI), and the files go, heaviest first, to the shard with the least time so far (longest
// processing time first; ties by name, so every job computes the same split). A file not in
// durations.json weighs the median, so a new spec runs at once; stale entries are ignored. Refresh
// the file when a spec's time changes by much: run the suite with
// `--reporter=json` (PLAYWRIGHT_JSON_OUTPUT_NAME=<file>) and pass the report(s) to --update.
// The unit is a file, so a file never splits across shards; keep a file well under a shard's time
// (split it otherwise). setup.spec.ts is the `setup` project, which every shard runs first (the
// other specs depend on it), so it is never assigned.
//
// Plain Node (no dependencies, no type stripping), so CI runs it before anything is built.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const durationsFile = join(e2eDir, "durations.json");
const SETUP = "setup.spec.ts";

/** The spec files the shards share (every `*.spec.ts` in e2e/ except the setup project's). */
export function specFiles(dir = e2eDir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts") && f !== SETUP)
    .sort();
}

/**
 * Assigns `files` to `total` shards by `durations` (seconds per file name); returns one sorted
 * list per shard. Unknown files weigh the median of the known ones (1 when none is known).
 */
export function assignShards(files, durations, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`invalid shard total ${total}`);
  const known = files
    .map((f) => durations[f])
    .filter((d) => typeof d === "number")
    .sort((a, b) => a - b);
  const median = known.length === 0 ? 1 : known[Math.floor(known.length / 2)];
  const weight = (f) => (typeof durations[f] === "number" ? durations[f] : median);
  const order = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const shards = Array.from({ length: total }, () => ({ files: [], time: 0 }));
  for (const f of order) {
    // the first shard with the least time: deterministic
    let target = shards[0];
    for (const s of shards) if (s.time < target.time) target = s;
    target.files.push(f);
    target.time += weight(f);
  }
  return shards.map((s) => s.files.sort());
}

/** Seconds per spec file in Playwright JSON reports (every result of every test, summed). */
export function durationsFromReports(reports) {
  const ms = {};
  const walk = (suite, file) => {
    const name = (suite.file ?? file)?.split("/").pop();
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const r of test.results ?? []) ms[name] = (ms[name] ?? 0) + (r.duration ?? 0);
      }
    }
    for (const child of suite.suites ?? []) walk(child, name);
  };
  for (const report of reports) for (const suite of report.suites ?? []) walk(suite, undefined);
  delete ms[SETUP];
  return Object.fromEntries(
    Object.entries(ms)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, v]) => [f, Math.max(1, Math.round(v / 1000))]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [arg, ...rest] = process.argv.slice(2);
  if (arg === "--update") {
    if (rest.length === 0) throw new Error("--update needs at least one Playwright JSON report");
    const reports = rest.map((f) => JSON.parse(readFileSync(f, "utf8")));
    writeFileSync(durationsFile, `${JSON.stringify(durationsFromReports(reports), null, 2)}\n`);
  } else {
    const m = /^(\d+)\/(\d+)$/.exec(arg ?? "");
    if (m === null) throw new Error("usage: shard.mjs <current>/<total> | --update <report>…");
    const [current, total] = [Number(m[1]), Number(m[2])];
    if (current < 1 || current > total) throw new Error(`no shard ${arg}`);
    const durations = JSON.parse(readFileSync(durationsFile, "utf8"));
    const files = assignShards(specFiles(), durations, total)[current - 1];
    // An empty list would make `playwright test` run every file: refuse instead.
    if (files.length === 0) throw new Error(`shard ${arg} has no spec files: use fewer shards`);
    // Paths as Playwright filters (regular expressions on the file path): `e2e/<name>` matches
    // only that file, even when another file's name ends with it (subagents vs
    // conversation-subagents).
    console.log(files.map((f) => `e2e/${f}`).join("\n"));
  }
}
