/**
 * Internal helper (not exported by index.ts): whether it is an absolute http(s) address no longer
 * than max.
 */
export function isHttpUrl(v: unknown, max = 2000): boolean {
  if (typeof v !== "string" || v.length > max) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
