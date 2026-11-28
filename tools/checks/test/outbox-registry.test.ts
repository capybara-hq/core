import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkOutboxRegistry, mayHoldOutboxFacts } from "../src/outbox-registry.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/outbox-registry/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("checkOutboxRegistry", () => {
  it("passes a registry whose entries state why they are idempotent and have a processor", () => {
    expect(checkOutboxRegistry(fixture("clean"))).toEqual([]);
  });

  it("reports an empty idempotent, a missing or processor-less file and an unmentioned name", () => {
    const root = fixture("bad");
    const file = join(root, "packages/kernel/src/infra/outbox/registry.ts");
    const want = readFileSync(file, "utf8")
      .split("\n")
      .flatMap((t, i) => (t.includes("// expect: outbox-registry") ? [i + 1] : []));
    const got = checkOutboxRegistry(root);
    expect(got.map((f) => f.line)).toEqual(want);
    expect(got.map((f) => relative(root, f.file))).toEqual(want.map(() => relative(root, file)));
    expect(got.map((f) => f.message)).toEqual([
      expect.stringContaining("idempotent"),
      expect.stringContaining("does not exist"),
      expect.stringContaining("@Processor("),
      expect.stringContaining('mention the job name "noName"'),
    ]);
  });

  it("reports an add whose resolvable queue is not one of its entry's queues", () => {
    const root = fixture("queue");
    const file = join(root, "packages/kernel/src/runtime/owes.ts");
    const want = readFileSync(file, "utf8")
      .split("\n")
      .flatMap((t, i) => (t.includes("// expect: outbox-registry") ? [i + 1] : []));
    const got = checkOutboxRegistry(root);
    expect(got.map((f) => [relative(root, f.file), f.line])).toEqual(
      want.map((line) => [relative(root, file), line]),
    );
    expect(got.map((f) => f.message)).toEqual([
      'job "bg-wake" is owed on queue "cap-kernel-runs", but its OUTBOX_JOBS entry lists "cap-kernel-maintenance"',
      'job "run" is owed on queue "cap-kernel-maintenance", but its OUTBOX_JOBS entry lists "cap-kernel-runs", "cap-kernel-subagent-runs"',
    ]);
  });

  it("parses only files that can hold a string constant or an outbox call", () => {
    expect(mayHoldOutboxFacts('export const WAKE_JOB = "bg-wake";')).toBe(true);
    expect(mayHoldOutboxFacts("export const A = make(),\n  B = 'b';")).toBe(true);
    expect(mayHoldOutboxFacts("await this.outbox.add(job);")).toBe(true);
    expect(mayHoldOutboxFacts("export const LIMIT = 10;\nconst s = 'x';")).toBe(false);
  });
});

describe("the real registry", () => {
  // One whole-kernel scan (about half a second idle, ten times that on a loaded parallel run): in
  // the hook, bounded by hookTimeout, so the test timeout covers only the assertions (#1087).
  let findings: ReturnType<typeof checkOutboxRegistry>;
  beforeAll(() => {
    findings = checkOutboxRegistry(repoRoot);
  });

  it("passes the real registry", () => {
    expect(existsSync(join(repoRoot, "packages/kernel/src/infra/outbox/registry.ts"))).toBe(true);
    expect(findings).toEqual([]);
  });
});
