import type { FieldMeta } from "./model";

/**
 * The org config adapter (`PUT /orgs/:orgId/extensions/:plugin` `config`): the whole object is
 * sent; a secret the person left alone is omitted (the kernel keeps it), a cleared one is `null`,
 * a replaced one its new value. The form's value already has that shape.
 */

type Obj = Record<string, unknown>;

/** `secrets: [{ path, set }]` of the view → per-field meta. */
export function orgFormMeta(
  secrets: readonly { path: string; set: boolean }[] | undefined,
): Record<string, FieldMeta> {
  return Object.fromEntries((secrets ?? []).map((s) => [s.path, { secretSet: s.set }]));
}

/** The form's value as the `config` to send (an object; undefined secrets drop out in JSON). */
export function orgConfig(value: unknown): Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : {};
}
