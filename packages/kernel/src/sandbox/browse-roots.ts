import { posix } from "node:path";

/** `path` lies at or below `root` (both absolute and normalized). */
const within = (path: string, root: string): boolean =>
  path === root || root === "/" || path.startsWith(`${root}/`);

/** An absolute, normalized posix path without a trailing `/` (except `/` itself). */
const plainAbsolute = (p: string): boolean =>
  posix.isAbsolute(p) && posix.normalize(p) === p && (p === "/" || !p.endsWith("/"));

/**
 * The read roots of an owner browse narrowed to `narrow` (composer menus §5: a project's files are
 * browsed in a scope rooted at the project path): each narrowing root that lies at or below one of
 * the owner's ceiling roots, never wider than the ceiling. A narrowing root outside every ceiling
 * root, or one that is not absolute and normalized, drops out. The result is deduplicated and may
 * be empty (the caller refuses the browse then).
 */
export function narrowReadRoots(ceiling: readonly string[], narrow: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of narrow) {
    if (!plainAbsolute(n)) continue;
    if (ceiling.some((c) => within(n, c))) out.add(n);
  }
  return [...out];
}
