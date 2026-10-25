import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packPlugin } from "@capybara-hq/pack-plugin";
import { parseBootstrapManifest } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

export interface BootstrapCheckOptions {
  /** Rewrite stale versions and integrities in the manifest instead of reporting them. */
  write?: boolean;
}

const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** 1-based line of the entry's `"name": "<name>"` in the manifest text, else 1. */
function lineOf(text: string, name: string): number {
  const i = text.search(new RegExp(`"name"\\s*:\\s*"${name}"`));
  return i < 0 ? 1 : text.slice(0, i).split("\n").length;
}

/**
 * The bootstrap manifest (`packages/kernel/bootstrap.json`) pins what the image bakes and init
 * installs, so it must match what the workspace packs:
 * - the manifest must parse (`parseBootstrapManifest`; rule `bootstrap-invalid`);
 * - every `source: "workspace"` entry's `path` (relative to `repoRoot`) is packed with
 *   `tools/pack-plugin` (byte-reproducible) into a temporary directory that is removed afterwards:
 *   a pack that fails is `bootstrap-pack`, a plugin whose name differs from the entry's is
 *   `bootstrap-name`, and a version or sha512 that differs from the pack's is `bootstrap-stale`
 *   (the message gives the expected value; `write` updates them in the file instead).
 *
 * `source: "npm"` entries are not checked here: comparing them with the official marketplace needs
 * the network and comes with the published plugins (phase A3).
 */
export async function checkBootstrap(
  manifestFile: string,
  repoRoot: string,
  opts: BootstrapCheckOptions = {},
): Promise<Finding[]> {
  const text = await readFile(manifestFile, "utf8");
  const at = (line: number, rule: string, message: string): Finding => ({
    file: manifestFile,
    line,
    rule,
    message,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return [at(1, "bootstrap-invalid", `not valid JSON: ${(e as Error).message}`)];
  }
  const parsed = parseBootstrapManifest(raw);
  if ("errors" in parsed) return parsed.errors.map((m) => at(1, "bootstrap-invalid", m));

  const findings: Finding[] = [];
  const rawPlugins = (raw as { plugins: Record<string, unknown>[] }).plugins;
  let rewritten = false;
  const out = await mkdtemp(join(tmpdir(), "check-bootstrap-"));
  try {
    for (const [i, e] of parsed.plugins.entries()) {
      if (e.source !== "workspace") continue;
      const line = lineOf(text, e.name);
      let packed: { name: string; version: string; integrity: string };
      try {
        const r = await packPlugin(join(repoRoot, e.path), out);
        packed = {
          name: r.manifest.name,
          version: r.manifest.version,
          integrity: integrityOf(new Uint8Array(await readFile(r.file))),
        };
        await rm(r.file, { force: true });
      } catch (err) {
        findings.push(
          at(
            line,
            "bootstrap-pack",
            `${e.name}: packing ${e.path} failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        continue;
      }
      if (packed.name !== e.name) {
        findings.push(
          at(
            line,
            "bootstrap-name",
            `${e.name}: ${e.path} packs the plugin "${packed.name}"; the entry name must equal it`,
          ),
        );
        continue;
      }
      for (const field of ["version", "integrity"] as const) {
        if (e[field] === packed[field]) continue;
        if (opts.write) {
          const target = rawPlugins[i];
          if (target) target[field] = packed[field];
          rewritten = true;
          continue;
        }
        findings.push(
          at(
            line,
            "bootstrap-stale",
            `${e.name}: ${field} is ${e[field]} but ${e.path} packs ${packed[field]}; run pnpm check:bootstrap --write`,
          ),
        );
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  if (rewritten) await writeFile(manifestFile, `${JSON.stringify(raw, null, 2)}\n`);
  return findings;
}
