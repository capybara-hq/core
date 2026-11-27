/**
 * Canonical JSON (eval replay matching): object keys sorted recursively by code point, arrays in
 * order, `undefined` left out by the JSON rules. A leaf module, so request building
 * (`evals/reconstruct.ts`, reached from the runtime through the in-context summary) does not pull
 * in the tool pipeline that `recorded-tools.ts` needs.
 */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v) ?? null);
}
