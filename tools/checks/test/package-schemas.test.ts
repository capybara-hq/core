import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkPackageSchemas,
  DEFAULT_SCHEMAS_DIR,
  PACKAGE_SCHEMAS,
  renderPackageSchema,
} from "../src/package-schemas.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/package-schemas", import.meta.url));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("checkPackageSchemas", () => {
  it("仓库里的 schema 文件与 SDK 的 zod schema 一致", () => {
    expect(checkPackageSchemas()).toEqual([]);
  });

  it("registers four schemas: the plugin, marketplace, connector template and bootstrap files", () => {
    expect(PACKAGE_SCHEMAS.map((s) => s.file)).toEqual([
      "plugin.v1.schema.json",
      "marketplace.v1.schema.json",
      "connector-template.v1.schema.json",
      "bootstrap.v1.schema.json",
    ]);
  });

  it("violating fixture: hand-edited schema files -> package-schema-stale", () => {
    const f = checkPackageSchemas(PACKAGE_SCHEMAS, join(FIXTURES, "stale"));
    expect(f.map((x) => [x.rule, x.file.split("/").pop()])).toEqual([
      ["package-schema-stale", "plugin.v1.schema.json"],
      ["package-schema-stale", "marketplace.v1.schema.json"],
      ["package-schema-stale", "connector-template.v1.schema.json"],
      ["package-schema-stale", "bootstrap.v1.schema.json"],
    ]);
    expect(f[0]?.message).toContain("pnpm gen:package-schemas");
  });

  it("missing files -> package-schema-stale", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    expect(checkPackageSchemas(PACKAGE_SCHEMAS, d).map((x) => x.rule)).toEqual(
      PACKAGE_SCHEMAS.map(() => "package-schema-stale"),
    );
  });

  it("a changed zod schema (one more required field) -> package-schema-stale", () => {
    const changed = PACKAGE_SCHEMAS.map((s) => ({
      ...s,
      schema: z.object({ schemaVersion: z.literal(1), extra: z.string() }),
    }));
    expect(checkPackageSchemas(changed).map((x) => x.rule)).toEqual(
      PACKAGE_SCHEMAS.map(() => "package-schema-stale"),
    );
  });

  it("目录里多出没有对应 schema 的 *.schema.json -> package-schema-unknown", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    for (const s of PACKAGE_SCHEMAS) writeFileSync(join(d, s.file), renderPackageSchema(s));
    writeFileSync(join(d, "old.v0.schema.json"), "{}\n");
    expect(checkPackageSchemas(PACKAGE_SCHEMAS, d).map((x) => x.rule)).toEqual([
      "package-schema-unknown",
    ]);
  });

  it("渲染确定，带 $id 与 title，以换行结尾", () => {
    const [s] = PACKAGE_SCHEMAS;
    if (!s) throw new Error("no schema");
    const out = renderPackageSchema(s);
    expect(renderPackageSchema(s)).toBe(out);
    expect(out.endsWith("\n")).toBe(true);
    const json = JSON.parse(out);
    expect(json.$id).toMatch(/plugin\.v1\.schema\.json$/);
    expect(json.title).toBeTruthy();
    expect(readFileSync(join(DEFAULT_SCHEMAS_DIR, s.file), "utf8")).toBe(out);
  });
});
