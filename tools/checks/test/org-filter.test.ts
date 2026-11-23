import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkOrgFilter, orgScopedTables } from "../src/org-filter.js";

const fixtures = fileURLToPath(new URL("../fixtures/org-filter", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** `// expect: <rule>` marks its own line, `// expect-above: <rule>` the line before. */
function expected(root: string): string[] {
  const out: string[] = [];
  for (const file of filesUnder(root)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        const m = /\/\/ expect(-above)?: (org-filter[a-z-]*)/.exec(text);
        if (m) out.push(`${m[2]} ${relative(root, file)}:${m[1] ? i : i + 1}`);
      });
  }
  return out.sort();
}

const run = (root: string) =>
  checkOrgFilter(root)
    .map((f) => `${f.rule} ${relative(root, f.file)}:${f.line}`)
    .sort();

describe("checkOrgFilter", () => {
  it("reads the org-scoped tables from the schema, following extends", () => {
    expect(orgScopedTables(join(fixtures, "clean"))).toEqual(new Set(["things", "notes"]));
  });

  it("passes a tree whose queries filter by org_id or carry a reasoned exemption", () => {
    expect(run(join(fixtures, "clean"))).toEqual([]);
  });

  it("reports exactly the marked lines of the violating fixture", () => {
    const root = join(fixtures, "bad");
    const want = expected(root);
    expect(want.length).toBeGreaterThan(0);
    expect(run(root)).toEqual(want);
  });

  it("fails when the schema has a table whose row type it cannot read", () => {
    expect(run(join(fixtures, "schema"))).toEqual([
      "org-filter-schema packages/kernel/src/db/kernel-schema.ts:3",
    ]);
  });

  it("passes the real kernel", () => {
    const tables = orgScopedTables(repoRoot);
    expect(tables instanceof Set && tables.has("conversations")).toBe(true);
    expect(checkOrgFilter(repoRoot)).toEqual([]);
  });
});
