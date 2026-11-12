import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkOutboxRegistry } from "../src/outbox-registry.js";

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

  it("passes the real registry", () => {
    expect(existsSync(join(repoRoot, "packages/kernel/src/infra/outbox/registry.ts"))).toBe(true);
    expect(checkOutboxRegistry(repoRoot)).toEqual([]);
  });
});
