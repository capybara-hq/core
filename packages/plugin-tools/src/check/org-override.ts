import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema } from "@capybara-hq/plugin-sdk";
import { extensionConfigSchemas } from "../pack/config-schemas.js";
import { importPluginExtension } from "../pack/pack.js";
import { findCtxCalls } from "./plugin-permissions.js";
import type { Finding } from "./source.js";

/** Extension points whose calls carry the org's per-call config on their own. */
const ORG_AWARE_POINTS = new Set([
  "web-search",
  "web-fetch",
  "directory",
  "model-provider",
  "file-preview",
]);

/** The top-level properties of a deployment schema marked `x-org: "override"`. */
function overrideFields(schema: JsonSchema | undefined): string[] {
  const props = schema?.properties;
  if (typeof props !== "object" || props === null) return [];
  return Object.entries(props as Record<string, unknown>)
    .filter(([, v]) => (v as Record<string, unknown> | null)?.["x-org"] === "override")
    .map(([k]) => k);
}

/**
 * `plugin-org-override-unbound` (a warning): an extension whose deployment config has an
 * `orgAccess(…, "override")` field, but that registers no tool, no `ctx.ui` view or action, no
 * hook and provides none of `web-search`, `web-fetch`, `directory`, `model-provider` or
 * `file-preview`. An override reaches the extension only in the per-call `config` of those entry
 * points, so the field can never take effect. Findings point at the plugin's `src/index.ts`.
 * A plugin that does not bundle or import is left to "Plugin pack".
 */
export async function checkOrgOverride(pluginDirs: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
    const file = join(dir, "src/index.ts");
    if (!existsSync(file)) continue;
    let ext: Awaited<ReturnType<typeof importPluginExtension>>;
    try {
      ext = await importPluginExtension(dir);
    } catch {
      continue;
    }
    const fields = overrideFields(extensionConfigSchemas(ext.config).schemas.deployment);
    if (fields.length === 0) continue;
    const calls = findCtxCalls(dir);
    if (calls.tools || calls.ui || calls.hooks) continue;
    const provided = (ext.provides ?? []).map((p) => String(p).split("@")[0] ?? "");
    if (provided.some((p) => ORG_AWARE_POINTS.has(p))) continue;
    findings.push({
      file,
      line: 1,
      rule: "plugin-org-override-unbound",
      severity: "warning",
      message: `deployment config field ${fields.join(", ")} allows an org override, but the extension registers no tool, ui view, action or hook and provides no org-aware extension point (${[...ORG_AWARE_POINTS].join(", ")}), so no per-call config ever reaches it`,
    });
  }
  return findings;
}
