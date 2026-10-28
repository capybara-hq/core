import { Buffer } from "node:buffer";
import {
  GitSourceError,
  MARKETPLACE_OFFICIAL_URL_DEFAULT,
  PACKAGES_MAX_BYTES_DEFAULT,
  readGitTree,
} from "@capybara-hq/kernel";
import {
  type BootstrapEntry,
  type BootstrapManifest,
  type MarketplaceEntry,
  parseMarketplaceManifest,
} from "@capybara-hq/plugin-sdk";
import { assertNpmTarballLabel, fetchNpmTarball } from "@capybara-hq/plugin-tools/pack";
import { integrityOf } from "@capybara-hq/plugin-tools/release";
import type { ComposeGitContext } from "./bootstrap-compose.js";

/** Options of the network mode of `check:bootstrap`. */
export interface BootstrapNetworkOptions {
  /** The npm registry the npm entries are fetched from (the image build uses the same). */
  registry: string;
  /** Read the marketplace from this repository URL instead of `marketplace.url` (a mirror; tests). */
  marketplaceUrl?: string;
  /** Tests only: plain http on loopback for the marketplace repository. */
  allowInsecureLoopback?: boolean;
  /** Bearer token for a private registry, sent to the registry origin only. */
  npmToken?: string;
}

type NpmEntry = Extract<BootstrapEntry, { source: "npm" }>;
/**
 * A problem of one entry (`entry` undefined: of the manifest as a whole), or of a line of another
 * file (`file`, `line`: a compose build context).
 */
export interface NetworkProblem {
  entry?: string;
  file?: string;
  line?: number;
  rule:
    | "bootstrap-npm"
    | "bootstrap-marketplace"
    | "bootstrap-marketplace-url"
    | "bootstrap-haproxy"
    | "bootstrap-compose-ref";
  message: string;
}

/** What else core takes from the plugins repository at `marketplace.commit`. */
export interface PluginsRepoFiles {
  /** Compose build contexts pinned to the commit: each `<dir>/Dockerfile` must exist there. */
  contexts?: ComposeGitContext[];
  /** Core's socket proxy config, which the sandbox-docker plugin's test copy must equal. */
  haproxy?: { file: string; bytes: Uint8Array };
}

const MARKETPLACE_FILE = ".capybara-plugin/marketplace.json";
/** The sandbox-docker plugin's test copy of core's `docker/sandbox-proxy/haproxy.cfg`. */
export const PLUGIN_HAPROXY_COPY = "plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg";
const dockerfileOf = (c: ComposeGitContext) => `${c.dir}/Dockerfile`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `bootstrap-npm`: each npm entry is published on `registry` at its version, the packument's
 * `dist.integrity` equals the pin, the tarball's bytes hash to the pin, and its package.json names
 * the entry's package and version (not mislabelled).
 */
async function checkNpmEntry(
  e: NpmEntry,
  registry: string,
  token: string | undefined,
): Promise<NetworkProblem[]> {
  const at = (message: string): NetworkProblem => ({
    entry: e.name,
    rule: "bootstrap-npm",
    message: `${e.name}: ${message}`,
  });
  let r: Awaited<ReturnType<typeof fetchNpmTarball>>;
  try {
    r = await fetchNpmTarball(e.npm, e.version, registry, {
      ...(token !== undefined && { token }),
    });
  } catch (err) {
    return [at(errText(err))];
  }
  const out: NetworkProblem[] = [];
  if (r.distIntegrity !== e.integrity) {
    out.push(
      at(
        `the registry's dist.integrity ${r.distIntegrity ?? "(none)"} for ${e.npm}@${e.version} is not the pinned ${e.integrity}`,
      ),
    );
  }
  const actual = integrityOf(r.bytes);
  if (actual !== e.integrity) {
    out.push(
      at(
        `${e.npm}@${e.version} from ${r.tarball} has sha512 ${actual}, not the pinned ${e.integrity}`,
      ),
    );
  }
  // The label matters once the bytes are the pinned ones (a pin taken from another package's tarball).
  if (out.length > 0) return out;
  try {
    await assertNpmTarballLabel(r.bytes, e.npm, e.version);
  } catch (err) {
    out.push(at(errText(err)));
  }
  return out;
}

/** The marketplace's version of an entry: `version`, else the npm source's (null: the plugin's own). */
const versionOf = (m: MarketplaceEntry): string | null =>
  m.version ?? ("npm" in m.source ? m.source.npm.version : null);

/**
 * `bootstrap-marketplace`: reads `.capybara-plugin/marketplace.json` at `marketplace.commit` with the
 * kernel's git reader; every npm entry must be listed there under its name at the same version, as
 * an npm source of the same package and integrity.
 */
async function checkMarketplace(
  m: NonNullable<BootstrapManifest["marketplace"]>,
  entries: NpmEntry[],
  opts: BootstrapNetworkOptions,
  extra: PluginsRepoFiles,
): Promise<NetworkProblem[]> {
  const wanted = [
    MARKETPLACE_FILE,
    ...(extra.haproxy === undefined ? [] : [PLUGIN_HAPROXY_COPY]),
    ...(extra.contexts ?? []).map(dockerfileOf),
  ];
  const url = opts.marketplaceUrl ?? m.url;
  const at = m.commit.slice(0, 12);
  const whole = (message: string): NetworkProblem[] => [{ rule: "bootstrap-marketplace", message }];
  let raw: Uint8Array | undefined;
  let files: Map<string, Uint8Array>;
  try {
    files = await readGitTree(
      { url, commit: m.commit },
      {
        net: {
          allowInsecureLoopback: opts.allowInsecureLoopback ?? false,
          allowPrivateHosts: [],
          trustedOrigins: [],
        },
        maxBytes: PACKAGES_MAX_BYTES_DEFAULT,
        signal: AbortSignal.timeout(120_000),
        include: (p) => wanted.some((w) => w === p || w.startsWith(`${p}/`)),
      },
    );
    raw = files.get(MARKETPLACE_FILE);
  } catch (e) {
    const why = e instanceof GitSourceError ? e.message : errText(e);
    return whole(`cannot read ${MARKETPLACE_FILE} at ${at} of ${url}: ${why}`);
  }
  const out: NetworkProblem[] = [...repoFiles(files, extra, url, at)];
  if (raw === undefined) return [...whole(`${url} has no ${MARKETPLACE_FILE} at ${at}`), ...out];
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return [...whole(`${MARKETPLACE_FILE} at ${at} is not valid JSON`), ...out];
  }
  const parsed = parseMarketplaceManifest(json);
  if ("errors" in parsed) {
    return [
      ...whole(`${MARKETPLACE_FILE} at ${at} is invalid: ${parsed.errors.join("; ")}`),
      ...out,
    ];
  }
  for (const e of entries) {
    const problem = (message: string) =>
      out.push({ entry: e.name, rule: "bootstrap-marketplace", message: `${e.name}: ${message}` });
    const named = parsed.plugins.filter((p) => p.name === e.name);
    if (named.length === 0) {
      problem(`the marketplace at ${at} has no entry ${e.name}`);
      continue;
    }
    const same = named.find((p) => versionOf(p) === e.version);
    if (same === undefined) {
      const versions = named.map((p) => versionOf(p) ?? "(the plugin's own)").sort();
      problem(
        `the marketplace at ${at} lists ${e.name} at ${versions.join(", ")}, not ${e.version}`,
      );
      continue;
    }
    const src = "npm" in same.source ? same.source.npm : undefined;
    if (src?.package !== e.npm || src.integrity !== e.integrity) {
      const listed =
        src === undefined
          ? `a ${Object.keys(same.source)[0]} source`
          : `npm ${src.package} with integrity ${src.integrity}`;
      problem(
        `the marketplace at ${at} lists ${e.name}@${e.version} as ${listed}, not npm ${e.npm} with integrity ${e.integrity}`,
      );
    }
  }
  return out;
}

/**
 * `bootstrap-haproxy`: the sandbox-docker plugin's test copy of the socket proxy config equals
 * core's file byte for byte; `bootstrap-compose-ref`: every compose build context pinned to the
 * commit has its Dockerfile there.
 */
function repoFiles(
  files: Map<string, Uint8Array>,
  extra: PluginsRepoFiles,
  url: string,
  at: string,
): NetworkProblem[] {
  const out: NetworkProblem[] = [];
  if (extra.haproxy !== undefined) {
    const copy = files.get(PLUGIN_HAPROXY_COPY);
    if (copy === undefined || !Buffer.from(copy).equals(Buffer.from(extra.haproxy.bytes))) {
      out.push({
        rule: "bootstrap-haproxy",
        message: `${PLUGIN_HAPROXY_COPY} at ${at} of ${url} ${copy === undefined ? "is missing" : `differs from ${extra.haproxy.file}`}; the plugin's tests must run the socket proxy core ships (change both in step)`,
      });
    }
  }
  for (const c of extra.contexts ?? []) {
    if (files.has(dockerfileOf(c))) continue;
    out.push({
      file: c.file,
      line: c.line,
      rule: "bootstrap-compose-ref",
      message: `${dockerfileOf(c)} is missing at ${at} of ${url}; this build context does not exist at marketplace.commit`,
    });
  }
  return out;
}

/**
 * The network half of `check:bootstrap` (package ecosystem spec §7): the npm entries against the
 * registry (`bootstrap-npm`) and against the official marketplace at `marketplace.commit`
 * (`bootstrap-marketplace`), the official marketplace URL (`bootstrap-marketplace-url`), and what
 * else core takes from that commit ({@link PluginsRepoFiles}: `bootstrap-haproxy`,
 * `bootstrap-compose-ref`). Workspace entries are not published and are left to the offline half.
 */
export async function checkBootstrapNetwork(
  manifest: BootstrapManifest,
  opts: BootstrapNetworkOptions,
  extra: PluginsRepoFiles = {},
): Promise<NetworkProblem[]> {
  const npm = manifest.plugins.filter((e): e is NpmEntry => e.source === "npm");
  const out: NetworkProblem[] = [];
  const m = manifest.marketplace;
  if (m !== undefined && m.url !== MARKETPLACE_OFFICIAL_URL_DEFAULT) {
    // The manifest names the official marketplace; a mirror is read with --marketplace-url instead.
    out.push({
      rule: "bootstrap-marketplace-url",
      message: `marketplace.url is ${m.url}; the bootstrap plugins must come from the official marketplace ${MARKETPLACE_OFFICIAL_URL_DEFAULT}`,
    });
  }
  for (const e of npm) out.push(...(await checkNpmEntry(e, opts.registry, opts.npmToken)));
  const needsRepo =
    npm.length > 0 || extra.haproxy !== undefined || (extra.contexts ?? []).length > 0;
  if (m !== undefined && needsRepo) {
    out.push(...(await checkMarketplace(m, npm, opts, extra)));
  }
  return out;
}
