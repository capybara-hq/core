import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every string leaf of a JSON subtree (the targets of an `imports` / `exports` entry, any condition). */
export function leaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(leaves);
  return [];
}

/** The `imports` map of a package directory's package.json (empty when there is none). */
export function packageImportsOf(dir: string): Record<string, unknown> {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return {};
  try {
    const imports = (JSON.parse(readFileSync(file, "utf8")) as { imports?: unknown }).imports;
    return typeof imports === "object" && imports !== null && !Array.isArray(imports)
      ? (imports as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Expands a `#xxx` subpath import through a package.json `imports` map: every target of every
 * condition (a pattern key `#a/*` substitutes its match, the longest matching prefix wins, as in
 * Node). Empty when no key maps the specifier (or every target is `null`).
 */
export function resolveHashImport(spec: string, imports: Record<string, unknown>): string[] {
  const direct = imports[spec];
  if (direct !== undefined) return leaves(direct);
  let best: { head: string; mid: string; v: unknown } | undefined;
  for (const [key, v] of Object.entries(imports)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (spec.startsWith(head) && spec.endsWith(tail) && spec.length >= head.length + tail.length) {
      if (best === undefined || head.length > best.head.length) {
        best = { head, mid: spec.slice(head.length, spec.length - tail.length), v };
      }
    }
  }
  return best === undefined ? [] : leaves(best.v).map((t) => t.replaceAll("*", best.mid));
}
