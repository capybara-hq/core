import type { z } from "zod";

/**
 * Marks a schema as a secret field (Zod 4 meta `{ secret: true }`), merging with existing meta
 * (`ui` hints, `hot`), so `secret(ui(x, …))` and `ui(secret(x), …)` are the same.
 */
export function secret<T extends z.ZodTypeAny>(schema: T): T {
  return schema.meta({ ...(schema.meta() ?? {}), secret: true }) as T;
}

/** 读取 schema 的 meta，判断是否敏感；内核 `meta({secret:true})` 同样可识别。 */
export function isSecret(schema: z.ZodTypeAny): boolean {
  return (schema.meta() as { secret?: unknown } | undefined)?.secret === true;
}
