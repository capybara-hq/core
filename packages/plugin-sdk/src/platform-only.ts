import type { z } from "zod";
import { withMeta, wrapperChain } from "./field-meta.js";

/**
 * Marks a deployment config field, or the whole deployment schema, as platform-only (Zod 4 meta
 * `{ platformOnly: true }`), merging with existing meta (`secret`, `hot`, `ui`), also the meta of
 * the nodes under `.optional()` / `.default()` and the other wrappers, so
 * `platformOnly(secret(x))` and `secret(platformOnly(x))` are the same. `configJsonSchema`
 * publishes it as `"x-platform-only": true`; it is allowed on the root and on its top-level
 * properties (a nested field has the level of its top-level key).
 *
 * Every deployment field without the mark is overridable: an org follows the platform's value until
 * it saves its own copy, and the extension reads it from the per-call `config` (the effective config
 * for the org), not from `ctx.config`. A platform-only field is set only by the platform and is never
 * shown to an org.
 *
 * The effective config of an org that has its own copy still contains the platform-only secrets,
 * which an org cannot set; it never contains an overridable platform secret. Never send a
 * platform-only secret to an endpoint taken from an overridable field: an org could point that
 * endpoint at a server it controls.
 */
export function platformOnly<T extends z.ZodTypeAny>(schema: T): T {
  return withMeta(schema, "platformOnly", true);
}

/**
 * Whether a schema carries the {@link platformOnly} mark. It sees through `.optional()`,
 * `.default()`, `.nullable()`, `.prefault()`, `.catch()` and `.readonly()` (true when any node of
 * the chain carries the mark, like `secret`: an outer `false` never clears an inner `true`), so it
 * agrees with the `"x-platform-only"` that `configJsonSchema` publishes.
 */
export function isPlatformOnly(schema: z.ZodTypeAny): boolean {
  for (const node of wrapperChain(schema)) {
    if ((node.meta() as { platformOnly?: unknown } | undefined)?.platformOnly === true) return true;
  }
  return false;
}
