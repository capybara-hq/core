import { createHash } from "node:crypto";
import type { core } from "zod";
import { configFields, getPath, setPath } from "../config/fields.js";

/** 键排序后的 JSON（对象键顺序不影响结果）；undefined 字段与 JSON.stringify 一样省略。 */
const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v))
    return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

/** 遮蔽 secret 字段后参与摘要的固定占位值。 */
const SECRET_PLACEHOLDER = "<secret>";

/**
 * 插件部署配置（校验后）中非密钥部分的摘要：先把 schema 里所有 secret 叶子（`configFields` 可达路径，
 * 加载时 `assertSecretsReachable` 已保证密钥都在这些路径上）换成固定占位值，再取 sha256(键排序 JSON) 前 16 位十六进制。
 * 给需要「配置变了就失效」的缓存键用（如模型列表）。密钥不参与摘要：不加盐的短摘要写进 Redis 键名后，
 * 低熵密钥可被离线猜测、泄露的密钥可被确认；代价是轮换密钥不会让缓存失效（缓存内容本来就不该依赖密钥）。
 * 没有部署配置 schema 时无从得知哪些是密钥，摘要不按配置区分。同一份配置在各副本上得到同一摘要。
 * 函数自己按 schema 遮蔽，调用方不必（也不能忘记）先打码。
 */
export function deploymentConfigHash(schema: core.$ZodType | undefined, config: unknown): string {
  let redacted: unknown = null;
  if (schema) {
    redacted = structuredClone(config);
    if (redacted !== null && typeof redacted === "object") {
      for (const f of configFields(schema)) {
        if (f.meta?.secret && getPath(redacted, f.path) !== undefined) {
          setPath(redacted as Record<string, unknown>, f.path, SECRET_PLACEHOLDER);
        }
      }
    }
  }
  return createHash("sha256").update(canonicalJson(redacted)).digest("hex").slice(0, 16);
}
