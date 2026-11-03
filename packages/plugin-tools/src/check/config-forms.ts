import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extensionConfigSchemas,
  formatConfigSchemaProblem,
  missingConfigLabels,
} from "../pack/config-schemas.js";
import { importPluginExtension } from "../pack/pack.js";
import type { Finding } from "./source.js";

/**
 * Config forms (extension config forms spec §10): every plugin with an extension (`src/index.ts`)
 * is bundled and imported the way the packer does, and its deployment and org config schemas are
 * turned into the form JSON Schemas the package carries.
 * - `plugin-config-ui`: a problem of their hints (`validateConfigUi` at the level, and value hints
 *   on secrets, which the JSON Schema drops silently); the packer refuses these too.
 * - `plugin-config-labels`: a published plugin (not `"private": true`) whose rendered field has no
 *   label in both zh and en (secret records drawn per item by `x-ui.secrets` are skipped).
 * A plugin that does not bundle or import is left to "Plugin pack", which reports it.
 * Findings point at the plugin's `src/index.ts`.
 */
export async function checkConfigForms(pluginDirs: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
    const file = join(dir, "src/index.ts");
    if (!existsSync(file)) continue;
    let config: Awaited<ReturnType<typeof importPluginExtension>>["config"];
    try {
      config = (await importPluginExtension(dir)).config;
    } catch {
      continue;
    }
    const { schemas, problems } = extensionConfigSchemas(config);
    for (const p of problems) {
      findings.push({
        file,
        line: 1,
        rule: "plugin-config-ui",
        message: formatConfigSchemaProblem(p),
      });
    }
    const pkgFile = join(dir, "package.json");
    const pkg = existsSync(pkgFile)
      ? (JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>)
      : {};
    if (pkg.private === true) continue;
    for (const level of ["deployment", "org"] as const) {
      const schema = schemas[level];
      if (schema === undefined) continue;
      for (const p of missingConfigLabels(schema)) {
        findings.push({
          file,
          line: 1,
          rule: "plugin-config-labels",
          message: `${level} config: ${p.path} ${p.message}: a published plugin labels every field it shows (ui(schema, { label: { zh, en } }))`,
        });
      }
    }
  }
  return findings;
}
