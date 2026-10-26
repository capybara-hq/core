import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBootstrapManifest } from "@capybara-hq/plugin-sdk";
import { packPlugin } from "@capybara-hq/plugin-tools/pack";
import { type BootstrapNetworkOptions, checkBootstrapNetwork } from "./bootstrap-network.js";
import type { Finding } from "./source.js";

export interface BootstrapCheckOptions {
  /** Rewrite stale versions and integrities in the manifest instead of reporting them. */
  write?: boolean;
  /** Also check the npm entries against the registry and the marketplace commit (network mode). */
  network?: BootstrapNetworkOptions;
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
 *   plugin-tools' `packPlugin` (byte-reproducible) into a temporary directory that is removed afterwards:
 *   a pack that fails is `bootstrap-pack`, a plugin whose name differs from the entry's is
 *   `bootstrap-name`, and a version or sha512 that differs from the pack's is `bootstrap-stale`
 *   (the message gives the expected value; `write` updates them in the file instead).
 *
 * `source: "npm"` entries need the network, so they are checked only with `network`
 * ({@link checkBootstrapNetwork}): published on the registry at the pinned version with the pinned
 * sha512 (`bootstrap-npm`: unpublished, a tampered tarball, or registry metadata that disagrees)
 * and listed at the same version and integrity in the official marketplace at `marketplace.commit`
 * (`bootstrap-marketplace`). Without `network` they are skipped.
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
  if (opts.network !== undefined) {
    for (const p of await checkBootstrapNetwork(parsed, opts.network)) {
      findings.push(at(p.entry === undefined ? 1 : lineOf(text, p.entry), p.rule, p.message));
    }
  }
  return findings;
}
