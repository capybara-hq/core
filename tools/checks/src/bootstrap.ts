import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKETPLACE_OFFICIAL_URL_DEFAULT } from "@capybara-hq/kernel";
import { parseBootstrapManifest } from "@capybara-hq/plugin-sdk";
import { packPlugin } from "@capybara-hq/plugin-tools/pack";
import { integrityOf } from "@capybara-hq/plugin-tools/release";
import { checkComposeRefs, composeGitContexts } from "./bootstrap-compose.js";
import { type BootstrapNetworkOptions, checkBootstrapNetwork } from "./bootstrap-network.js";
import type { Finding } from "./source.js";

export interface BootstrapCheckOptions {
  /** Rewrite stale versions and integrities in the manifest instead of reporting them. */
  write?: boolean;
  /** Also check the npm entries against the registry and the marketplace commit (network mode). */
  network?: BootstrapNetworkOptions;
  /**
   * Compose files whose git build contexts of the plugins repository must be pinned to
   * `marketplace.commit` (`bootstrap-compose-ref`; with `network`, each context's `Dockerfile` must
   * also exist at that commit).
   */
  composeFiles?: string[];
  /**
   * Core's socket proxy config (`docker/sandbox-proxy/haproxy.cfg`); with `network`, the
   * sandbox-docker plugin's test copy at `marketplace.commit` must equal it (`bootstrap-haproxy`).
   */
  haproxyFile?: string;
}

/** Core's compose files (repo-relative) whose sandbox images build from the plugins repository. */
export const BOOTSTRAP_COMPOSE_FILES = ["docker/compose.yaml", "docker/compose.dev.yaml"];
/** Core's socket proxy config (repo-relative), copied by the sandbox-docker plugin's tests. */
export const SANDBOX_PROXY_HAPROXY = "docker/sandbox-proxy/haproxy.cfg";

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
 * (`bootstrap-marketplace`), whose URL must be the official one (`bootstrap-marketplace-url`).
 * Without `network` they are skipped.
 *
 * With `composeFiles`, every git build context of the plugins repository in them must be pinned to
 * `marketplace.commit` (`bootstrap-compose-ref`, offline); with `network` as well, its Dockerfile
 * must exist at that commit, and with `haproxyFile` the plugin's test copy of the socket proxy
 * config there must equal core's file (`bootstrap-haproxy`).
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
  const repoUrls = [
    MARKETPLACE_OFFICIAL_URL_DEFAULT,
    ...(parsed.marketplace ? [parsed.marketplace.url] : []),
  ];
  const contexts = (
    await Promise.all((opts.composeFiles ?? []).map((f) => composeGitContexts(f, repoUrls)))
  ).flat();
  const badRefs = checkComposeRefs(contexts, parsed);
  findings.push(...badRefs);
  if (opts.network !== undefined) {
    const pinned = contexts.filter(
      (c) => !badRefs.some((b) => b.file === c.file && b.line === c.line),
    );
    const problems = await checkBootstrapNetwork(parsed, opts.network, {
      contexts: pinned,
      ...(opts.haproxyFile !== undefined && {
        haproxy: {
          file: opts.haproxyFile,
          bytes: new Uint8Array(await readFile(opts.haproxyFile)),
        },
      }),
    });
    for (const p of problems) {
      if (p.file !== undefined) {
        findings.push({ file: p.file, line: p.line ?? 1, rule: p.rule, message: p.message });
        continue;
      }
      findings.push(at(p.entry === undefined ? 1 : lineOf(text, p.entry), p.rule, p.message));
    }
  }
  return findings;
}
