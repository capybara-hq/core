import type { z } from "zod";
import { chainMeta, withMeta } from "./field-meta.js";

/**
 * Marks a schema as a secret field (Zod 4 meta `{ secret: true }`), merging with existing meta
 * (`ui` hints, `hot`, `platformOnly`), also the meta of the nodes under `.optional()` /
 * `.default()` and the other wrappers, so `secret(ui(x, …))` and `ui(secret(x), …)` are the same.
 */
export function secret<T extends z.ZodTypeAny>(schema: T): T {
  return withMeta(schema, "secret", true);
}

/**
 * Whether a schema is sensitive: `secret: true` in its meta or in the meta of any node it wraps
 * through `.optional()`, `.default()`, `.nullable()`, `.prefault()`, `.catch()` and `.readonly()`
 * (fail-safe: an outer meta never hides the mark). The kernel's `meta({secret:true})` is recognized
 * the same way.
 */
export function isSecret(schema: z.ZodTypeAny): boolean {
  return chainMeta(schema).secret === true;
}
