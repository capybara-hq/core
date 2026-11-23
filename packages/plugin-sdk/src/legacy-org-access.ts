import type { z } from "zod";

/**
 * @deprecated Removed by core#720; kept only so plugin modules packed before core#720 still load.
 * Fields are org-overridable by default (`platformOnly` marks platform-only). Removed in core#720
 * plan Task 17.
 */
export type OrgAccess = "readonly" | "override";

/**
 * @deprecated Removed by core#720; kept only so plugin modules packed before core#720 still load;
 * fields are org-overridable by default (`platformOnly` marks platform-only). Removed in core#720
 * plan Task 17.
 *
 * A no-op: it returns `schema` unchanged and adds no meta. Both levels are ignored: the field stays
 * an ordinary deployment field, overridable by orgs unless it is marked {@link platformOnly};
 * `"readonly"` in particular makes nothing visible to orgs or read-only. New code never calls it.
 */
export function orgAccess<T extends z.ZodTypeAny>(schema: T, _access: OrgAccess): T {
  return schema;
}
