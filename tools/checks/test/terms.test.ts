import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkTerms } from "../src/terms.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/terms/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** 1-based line of the first line containing `needle`. */
function lineOf(file: string, needle: string): number {
  const i = readFileSync(file, "utf8")
    .split("\n")
    .findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`"${needle}" not in ${file}`);
  return i + 1;
}

describe("checkTerms", () => {
  it("passes new names, frozen names and the plan-0b allowlist", () => {
    expect(checkTerms(fixture("clean"))).toEqual([]);
  });

  it("reports each old term once, with its file and line", () => {
    const root = fixture("violations");
    const at = (rel: string, needle: string) => {
      const file = join(root, rel);
      return [file, lineOf(file, needle)];
    };
    const f = checkTerms(root);
    expect(f.map((x) => [x.rule, x.file, x.line])).toEqual([
      ["terms-sdk-api", ...at("packages/plugin-sdk/api/plugin-sdk.api.md", "definePlugin")],
      ["terms-error-code", ...at("packages/kernel/src/errors.ts", "directory.item_not_found")],
      ["terms-config-key", ...at("packages/kernel/src/config/schema.ts", "pluginHost")],
      [
        "terms-route",
        ...at("packages/kernel/src/catalog/catalog.controller.ts", "api/v1/admin/catalogs"),
      ],
      ["terms-cli", ...at("apps/capybara/src/args.ts", "capybara plugins list")],
      ["terms-reference", ...at("docs/guide.md", "CAPYBARA_PLUGIN_CONFIG")],
    ]);
    expect(f[0]?.message).toContain('"definePlugin"');
    expect(f[3]?.message).toContain("/marketplaces");
    expect(f[5]?.message).toContain("CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__BUCKET");
  });

  it("the repository uses no old term", () => {
    expect(checkTerms(repoRoot)).toEqual([]);
  });
});
