/** 内部工具（index.ts 不导出）：是否为 http(s) 绝对地址且长度不超过 max。 */
export function isHttpUrl(v: unknown, max = 2000): boolean {
  if (typeof v !== "string" || v.length > max) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
