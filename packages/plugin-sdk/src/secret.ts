import type { z } from "zod";

/** 标记一个 schema 为敏感字段（Zod 4 meta `{ secret: true }`）。 */
export function secret<T extends z.ZodTypeAny>(schema: T): T {
  return schema.meta({ secret: true }) as T;
}

/** 读取 schema 的 meta，判断是否敏感；内核 `meta({secret:true})` 同样可识别。 */
export function isSecret(schema: z.ZodTypeAny): boolean {
  return (schema.meta() as { secret?: unknown } | undefined)?.secret === true;
}
