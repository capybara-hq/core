import semver from "semver";

/**
 * Internal helper (not exported from index.ts): whether a semver range has an upper bound, i.e.
 * every comparator set (each `||` branch) has at least one `<` / `<=` or an exact version. Ranges
 * such as `*`, `x` or `>=1.0.0` would treat a future major SDK as compatible.
 */
export function hasUpperBound(range: string): boolean {
  const r = new semver.Range(range);
  return r.set.every((comparators) =>
    comparators.some(
      (c) =>
        c.operator === "<" ||
        c.operator === "<=" ||
        ((c.operator === "" || c.operator === "=") && c.value !== ""),
    ),
  );
}
