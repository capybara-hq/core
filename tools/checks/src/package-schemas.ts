import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConnectorTemplateFileSchema,
  MarketplaceManifestSchema,
  PluginManifestSchema,
} from "@capybara-hq/plugin-sdk";
import { type core, z } from "zod";
import type { Finding } from "./source.js";

/** 一份由 zod schema 生成、提交在 SDK `schemas/` 下的 JSON Schema。 */
export interface PackageSchemaSpec {
  /** 文件名（`<名字>.v<版本>.schema.json`）。 */
  file: string;
  /** `$id`。 */
  id: string;
  title: string;
  schema: core.$ZodType;
}

/**
 * The JSON Schemas the SDK publishes: the plugin manifest `plugin.json`, the marketplace manifest
 * `marketplace.json` and the connector template file `connectors/<id>.json`.
 */
export const PACKAGE_SCHEMAS: PackageSchemaSpec[] = [
  {
    file: "plugin.v1.schema.json",
    id: "https://capybarahq.com/schemas/plugin.v1.schema.json",
    title: "Capybara plugin manifest .capybara-plugin/plugin.json (schemaVersion 1)",
    schema: PluginManifestSchema,
  },
  {
    file: "marketplace.v1.schema.json",
    id: "https://capybarahq.com/schemas/marketplace.v1.schema.json",
    title: "Capybara marketplace manifest marketplace.json (schemaVersion 1)",
    schema: MarketplaceManifestSchema,
  },
  {
    file: "connector-template.v1.schema.json",
    id: "https://capybarahq.com/schemas/connector-template.v1.schema.json",
    title: "Capybara connector template file connectors/<id>.json",
    schema: ConnectorTemplateFileSchema,
  },
];

/** 仓库里的 `packages/plugin-sdk/schemas/`。 */
export const DEFAULT_SCHEMAS_DIR = fileURLToPath(
  new URL("../../../packages/plugin-sdk/schemas", import.meta.url),
);

/**
 * Renders one JSON Schema with `z.toJSONSchema(schema, { io: "input" })`. Strict zod objects (such as
 * plugin.v1 and connector-template.v1) emit `additionalProperties: false`; non-strict ones emit none,
 * matching zod dropping unknown fields (forward-compatible manifests). zod refine rules (cross-field
 * uniqueness and the like) do not appear in the JSON Schema.
 */
export function renderPackageSchema(spec: PackageSchemaSpec): string {
  const { $schema, ...rest } = z.toJSONSchema(spec.schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return `${JSON.stringify({ $schema, $id: spec.id, title: spec.title, ...rest }, null, 2)}\n`;
}

/**
 * 重新生成每份 schema 并与 `dir` 里的文件比对：不一致或缺失 → `package-schema-stale`；目录里多出没有对应 zod
 * schema 的 `*.schema.json` → `package-schema-unknown`。
 */
export function checkPackageSchemas(
  specs: PackageSchemaSpec[] = PACKAGE_SCHEMAS,
  dir: string = DEFAULT_SCHEMAS_DIR,
): Finding[] {
  const findings: Finding[] = [];
  for (const s of specs) {
    const file = join(dir, s.file);
    const actual = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (actual === renderPackageSchema(s)) continue;
    findings.push({
      file,
      line: 1,
      rule: "package-schema-stale",
      message:
        actual === undefined
          ? "JSON Schema 文件不存在；运行 pnpm gen:package-schemas 生成"
          : "JSON Schema 与 SDK 的 zod schema 不一致；运行 pnpm gen:package-schemas 重新生成并提交（不要手工编辑）",
    });
  }
  const known = new Set(specs.map((s) => s.file));
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".schema.json")) : [];
  for (const f of present.sort()) {
    if (known.has(f)) continue;
    findings.push({
      file: join(dir, f),
      line: 1,
      rule: "package-schema-unknown",
      message: "没有对应 zod schema 的 JSON Schema 文件；在 PACKAGE_SCHEMAS 登记或删除它",
    });
  }
  return findings;
}
