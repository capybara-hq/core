import type { OrgOverrideView } from "../../lib/extensions";
import type { JsonSchema } from "../../lib/json-schema";
import { fieldsSchema } from "./deployment";
import {
  buildTree,
  type FieldMeta,
  fromDraft,
  getPath,
  hasConfigFields,
  type Locale,
  sameJson,
  setPath,
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

/** What the org form draws for an {@link OrgOverrideView}. */
export interface OverrideForm {
  schema: JsonSchema;
  value: Obj;
  meta: Record<string, FieldMeta>;
}

/**
 * An org's two-level config (`GET …/overrides`) → the form: read-only fields are locked and
 * labelled as the platform's; overridable ones show the platform's value while the org follows it
 * and the copy's own once there is one; a secret shows whose it is, never a value. While following,
 * the secrets the platform holds are required, so the first edit comes with the org's own keys
 * (spec A §5.4); with a copy, the secrets the kernel names in `issues` are.
 */
export function overrideForm(view: OrgOverrideView): OverrideForm {
  const copy = view.state === "copy";
  const issued = new Set(view.issues.map((i) => i.path));
  let value: Obj = {};
  const meta: Record<string, FieldMeta> = {};
  const required = new Set<string>();
  const fields: { path: string; secret: boolean; value?: unknown }[] = [];
  for (const f of view.fields) {
    const own = f.level === "override" && copy;
    const shown = own ? f.org : f.platform;
    fields.push({ path: f.path, secret: f.secret, value: f.secret ? undefined : shown?.value });
    if (!f.secret && shown?.value !== undefined) value = setPath(value, f.path, shown.value);
    const m: FieldMeta = {};
    if (f.level === "readonly") m.readonly = "platform";
    else if (!own && !f.secret) m.platform = f.platform;
    if (f.secret) {
      const set = own ? f.org?.set === true : f.platform.set === true;
      m.secretState = set ? (own ? "own" : "platform") : "unset";
      m.secretSet = own && set;
      if (f.level === "override" && ((!copy && f.platform.set === true) || issued.has(f.path)))
        required.add(f.path);
    }
    meta[f.path] = m;
  }
  // Without the kernel's schema (an older kernel) the form is built from the fields and the
  // required secrets are inferred above; with it, its own `required` decides.
  return { schema: view.schema ?? fieldsSchema(fields, required), value, meta };
}

/**
 * The problems that are the org's to fix: a read-only field is the platform's, so a required one
 * the platform left empty never blocks the org's save.
 */
export function orgProblems<P extends { segments: readonly (string | number)[] }>(
  view: OrgOverrideView,
  problems: readonly P[],
): P[] {
  const readonly = view.fields.filter((f) => f.level === "readonly").map((f) => f.path);
  return problems.filter((p) => {
    const at = p.segments.filter((x): x is string => typeof x === "string").join(".");
    return !readonly.some((r) => at === r || at.startsWith(`${r}.`));
  });
}

/**
 * The `PUT …/overrides` `values`: overridable non-secret fields whose value changed against
 * `baseline` (a cleared one is `null`) and secrets that were typed; read-only fields never.
 */
export function overrideValues(
  view: OrgOverrideView,
  baseline: unknown,
  value: unknown,
): Record<string, unknown> {
  const values: Obj = {};
  for (const f of view.fields) {
    if (f.level !== "override") continue;
    const now = getPath(value, f.path);
    if (f.secret) {
      if (now !== undefined) values[f.path] = now;
    } else if (!sameJson(getPath(baseline, f.path), now)) values[f.path] = now ?? null;
  }
  return values;
}
