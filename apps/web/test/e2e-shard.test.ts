import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error the script is plain ESM without types
import { assignShards, durationsFromReports, specFiles } from "../e2e/shard.mjs";

type Assign = (files: string[], durations: Record<string, number>, total: number) => string[][];
const assign = assignShards as Assign;
const sum = (files: string[], d: Record<string, number>) =>
  files.reduce((t, f) => t + (d[f] ?? 0), 0);

describe("e2e shards by duration", () => {
  it("puts the heaviest file first on the emptiest shard, so the times even out", () => {
    const d = {
      "a.spec.ts": 300,
      "b.spec.ts": 200,
      "c.spec.ts": 150,
      "d.spec.ts": 100,
      "e.spec.ts": 50,
    };
    const shards = assign(Object.keys(d), d, 2);
    expect(shards).toEqual([
      ["a.spec.ts", "d.spec.ts"],
      ["b.spec.ts", "c.spec.ts", "e.spec.ts"],
    ]);
    expect(shards.map((s) => sum(s, d))).toEqual([400, 400]);
  });

  it("gives every file exactly one shard, the same split on every call", () => {
    const files = specFiles() as string[];
    const d = JSON.parse(
      readFileSync(new URL("../e2e/durations.json", import.meta.url), "utf8"),
    ) as Record<string, number>;
    const shards = assign(files, d, 3);
    expect(shards.flat().sort()).toEqual(files);
    expect(assign([...files].reverse(), d, 3)).toEqual(shards);
    // the setup project runs in every shard, never assigned
    expect(files).not.toContain("setup.spec.ts");
  });

  it("weighs a file without a measurement as the median", () => {
    const d = { "a.spec.ts": 10, "b.spec.ts": 20, "c.spec.ts": 90 };
    // new.spec.ts weighs 20: it joins the shard with 30 (a + b), not the one with 90
    expect(assign(["a.spec.ts", "b.spec.ts", "c.spec.ts", "new.spec.ts"], d, 2)).toEqual([
      ["c.spec.ts"],
      ["a.spec.ts", "b.spec.ts", "new.spec.ts"],
    ]);
  });

  it("sums a JSON report's results per file in seconds, without the setup project", () => {
    const report = {
      suites: [
        {
          file: "setup.spec.ts",
          specs: [{ tests: [{ results: [{ duration: 5000 }] }] }],
        },
        {
          file: "chat.spec.ts",
          specs: [{ tests: [{ results: [{ duration: 1200 }] }] }],
          suites: [{ specs: [{ tests: [{ results: [{ duration: 2400 }] }] }] }],
        },
      ],
    };
    expect(durationsFromReports([report])).toEqual({ "chat.spec.ts": 4 });
  });
});
