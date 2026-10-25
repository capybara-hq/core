import { type NpmFetchConfig, readCapped } from "./npm.js";

/**
 * npm provenance for the import review (spec §5.5, Decision 7): the registry's attestations of
 * `name@version` (`<registry>/-/npm/v1/attestations/<name>@<version>`) are read and the SLSA
 * provenance statement (in-toto, inside a DSSE envelope) is parsed for the repository, commit and
 * workflow it was built from. This is display only: the sigstore signatures are not verified, and
 * nothing here ever fails an import. A registry without provenance, a network error, a timeout, an
 * oversized or malformed answer all give `{ checked: false, reason }` ("provenance not checked").
 * The registry token goes only to the registry (the attestation URL is always on its origin).
 */

/** What the SLSA provenance of an npm package says about its build. */
export interface Provenance {
  checked: true;
  /** The source repository, as attested (e.g. `https://github.com/acme/plugins`). */
  repository: string;
  /** The git commit the package was built from. */
  commit: string;
  /** The workflow file that built it (e.g. `.github/workflows/release.yml`). */
  workflow: string;
  /** The SLSA build type (which CI system's build definition). */
  buildType: string;
}

/** Provenance was not checked (no attestation, offline, or an answer that could not be read). */
export interface ProvenanceNotChecked {
  checked: false;
  reason: string;
}

export type ProvenanceResult = Provenance | ProvenanceNotChecked;

/** The predicate type of an SLSA v1 provenance statement. */
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

/** Attestation answers are a few KB; anything far larger is not one. */
const MAX_ATTESTATION_BYTES = 1024 * 1024;
/** Provenance must not hold up an import: a slow registry gives "not checked". */
export const PROVENANCE_TIMEOUT_MS = 15_000;

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SEMVER_RE = /^[0-9A-Za-z.+-]{1,256}$/;
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const notChecked = (reason: string): ProvenanceNotChecked => ({ checked: false, reason });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : undefined;

/** The hex sha512 of a `sha512-<base64>` integrity (undefined for anything else). */
function sha512Hex(integrity: string): string | undefined {
  for (const part of integrity.trim().split(/\s+/)) {
    const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(part);
    if (m) {
      const b = Buffer.from(m[1] as string, "base64");
      if (b.length === 64) return b.toString("hex");
    }
  }
  return undefined;
}

/**
 * Reads the SLSA provenance of `name@version` from the configured registry. `integrity` (the
 * tarball's `sha512-…`, when known) must be among the statement's subject digests, so a statement
 * about another tarball is not shown. Never throws (an aborted `signal` included).
 */
export async function fetchProvenance(
  cfg: NpmFetchConfig,
  name: string,
  version: string,
  signal: AbortSignal,
  opts: { integrity?: string } = {},
): Promise<ProvenanceResult> {
  if (!NPM_NAME_RE.test(name) || name.length > 214 || !SEMVER_RE.test(version)) {
    return notChecked("not a valid npm package name and version");
  }
  let body: unknown;
  try {
    const registry = new URL(cfg.registry.endsWith("/") ? cfg.registry : `${cfg.registry}/`);
    // the npm client's escaping: a scoped name's `/` is %2f
    const url = new URL(
      `-/npm/v1/attestations/${name.replace("/", "%2f")}@${encodeURIComponent(version)}`,
      registry,
    );
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(cfg.token !== undefined && { authorization: `Bearer ${cfg.token}` }),
      },
      redirect: "manual",
      signal,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return notChecked("the registry has no provenance for this version");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return notChecked(`the registry answered HTTP ${res.status} for the attestations`);
    }
    const raw = await readCapped(
      res,
      MAX_ATTESTATION_BYTES,
      () => new Error("the attestations are too large"),
    );
    body = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    if (signal.aborted) return notChecked("the registry did not answer in time");
    return notChecked(`cannot read the attestations: ${errMsg(e)}`);
  }
  try {
    return parseAttestations(body, opts.integrity);
  } catch (e) {
    return notChecked(`cannot read the attestations: ${errMsg(e)}`);
  }
}

/**
 * Parses an attestations answer (`{ attestations: [{ predicateType, bundle: { dsseEnvelope } }] }`).
 * Exported for tests.
 */
export function parseAttestations(body: unknown, integrity?: string): ProvenanceResult {
  if (!isObject(body) || !Array.isArray(body.attestations)) {
    return notChecked("the attestations answer is not in the npm format");
  }
  const att = body.attestations.find(
    (a): a is Record<string, unknown> => isObject(a) && a.predicateType === SLSA_PROVENANCE_V1,
  );
  if (!att) return notChecked("the registry has no SLSA provenance for this version");
  const env = isObject(att.bundle) ? att.bundle.dsseEnvelope : undefined;
  if (!isObject(env) || typeof env.payload !== "string") {
    return notChecked("the provenance has no DSSE envelope");
  }
  if (env.payloadType !== "application/vnd.in-toto+json") {
    return notChecked("the provenance is not an in-toto statement");
  }
  let stmt: unknown;
  try {
    stmt = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8"));
  } catch {
    return notChecked("the provenance statement is not valid JSON");
  }
  if (!isObject(stmt) || stmt.predicateType !== SLSA_PROVENANCE_V1 || !isObject(stmt.predicate)) {
    return notChecked("the provenance statement is not SLSA provenance v1");
  }
  if (integrity !== undefined) {
    const want = sha512Hex(integrity);
    const subjects = Array.isArray(stmt.subject) ? stmt.subject : [];
    const matches = subjects.some(
      (s) => isObject(s) && isObject(s.digest) && s.digest.sha512 === want,
    );
    if (want === undefined || !matches) {
      return notChecked("the provenance is about another tarball than the one downloaded");
    }
  }
  const def = stmt.predicate.buildDefinition;
  if (!isObject(def)) return notChecked("the provenance has no build definition");
  const workflow = isObject(def.externalParameters) ? def.externalParameters.workflow : undefined;
  const repository = isObject(workflow) ? str(workflow.repository) : undefined;
  const path = isObject(workflow) ? str(workflow.path) : undefined;
  const deps = Array.isArray(def.resolvedDependencies) ? def.resolvedDependencies : [];
  const first = deps[0];
  const commit =
    isObject(first) && isObject(first.digest) ? str(first.digest.gitCommit) : undefined;
  const buildType = str(def.buildType);
  if (repository === undefined) return notChecked("the provenance names no repository");
  if (path === undefined) return notChecked("the provenance names no workflow");
  if (commit === undefined || !COMMIT_RE.test(commit)) {
    return notChecked("the provenance names no git commit");
  }
  if (buildType === undefined) return notChecked("the provenance names no build type");
  return { checked: true, repository, commit, workflow: path, buildType };
}

/** A repository URL compared case-insensitively, without `git+`, `.git` and a trailing `/`. */
function repoKey(url: string): string {
  const s = url
    .trim()
    .replace(/^git\+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  try {
    const u = new URL(s);
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return s.toLowerCase();
  }
}

/** Two repository URLs name the same repository (scheme, `git+`, `.git`, case ignored). */
export function sameRepository(a: string, b: string): boolean {
  return repoKey(a) === repoKey(b);
}
