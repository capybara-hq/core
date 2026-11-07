import type { JsonSchema } from "../../lib/json-schema";
import {
  buildTree,
  type FieldMeta,
  fromDraft,
  hasConfigFields,
  type Locale,
  toDraft,
} from "./model";

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

/**
 * The saved org config has every required field (and no client problem), read without drawing
 * the form: what the form reports on its first render (`state.problems` empty). An extension that
 * is off with an incomplete saved config waits for its config (待配置): the switch is read-only.
 */
export function savedConfigComplete(
  schema: JsonSchema | null | undefined,
  config: Record<string, unknown> | null,
  secrets: readonly { path: string; set: boolean }[] | undefined,
  locale: Locale,
): boolean {
  if (!hasConfigFields(schema)) return true;
  const tree = buildTree(schema, locale);
  const meta = orgFormMeta(secrets);
  return (
    fromDraft(tree, toDraft(tree, config ?? {}), {
      secretSet: (p) => meta[p]?.secretSet === true,
    }).problems.length === 0
  );
}
