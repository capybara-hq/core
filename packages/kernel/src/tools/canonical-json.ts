/**
 * 键排序、去掉 undefined 的 JSON（jsonb 不保留键顺序，指纹必须与顺序无关）。A leaf module (re-exported by
 * registry.ts): the sandbox service compares handles with it without importing the tool registry,
 * which imports the builtin tools that inject the sandbox service (an ESM import cycle).
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
