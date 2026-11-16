import type { z } from "zod";

/**
 * Marks a schema as a secret field (Zod 4 meta `{ secret: true }`), merging with existing meta
 * (`ui` hints, `hot`), so `secret(ui(x, …))` and `ui(secret(x), …)` are the same.
 */
export function secret<T extends z.ZodTypeAny>(schema: T): T {
  return schema.meta({ ...(schema.meta() ?? {}), secret: true }) as T;
}

/** Reads the schema's meta to tell whether it is sensitive; the kernel's `meta({secret:true})` is recognized the same way. */
export function isSecret(schema: z.ZodTypeAny): boolean {
  return (schema.meta() as { secret?: unknown } | undefined)?.secret === true;
}
