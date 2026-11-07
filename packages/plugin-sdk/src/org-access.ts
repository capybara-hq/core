import type { z } from "zod";

/**
 * How an org may treat a deployment config field: `readonly` (the org sees it, never sets it) or
 * `override` (an org may set its own value). A field without a level is deployment-only.
 */
export type OrgAccess = "readonly" | "override";

/**
 * Marks a deployment config field with an org access level (Zod 4 meta `{ org: access }`), merging
 * with existing meta (`secret`, `hot`, `ui`), so `orgAccess(secret(x), …)` and
 * `secret(orgAccess(x, …))` are the same. `configJsonSchema` publishes it as `"x-org"`.
 *
 * The author's promise for `override`: the extension reads the field from the per-call `config`
 * the kernel passes with each request, not from `ctx.config`, and the field may be absent from
 * `ctx.config` (the deployment value is the default, which an org may replace per call).
 */
export function orgAccess<T extends z.ZodTypeAny>(schema: T, access: OrgAccess): T {
  return schema.meta({ ...(schema.meta() ?? {}), org: access }) as T;
}

/** The org access level of a schema's meta, or undefined when it has none. */
export function orgAccessOf(schema: z.ZodTypeAny): OrgAccess | undefined {
  const v = (schema.meta() as { org?: unknown } | undefined)?.org;
  return v === "readonly" || v === "override" ? v : undefined;
}
