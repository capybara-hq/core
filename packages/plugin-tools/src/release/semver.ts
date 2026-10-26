/** Plain semver helpers shared by the npm dist-tag rule and core's image `latest` rule. */

/** A plain semver without build metadata (also a valid image tag: `+` is not allowed in tags). */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z-]+)*)?$/;

export const isPrerelease = (version: string) => version.includes("-");

/** Parses a plain semver (`latest`, digests and other strings give undefined). */
export function parseSemver(v: string): { core: number[]; pre: string[] } | undefined {
  if (!SEMVER_RE.test(v)) return undefined;
  const [core = "", pre] = v.split(/-(.*)/s);
  return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
}

/** Semver precedence (no build metadata): negative when a < b. Both must be plain semvers. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === undefined || y === undefined) throw new Error(`not a semver: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  // A version without a prerelease part ranks above any prerelease of it.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
