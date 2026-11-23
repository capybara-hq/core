import type { OrgOverrideView } from "../../lib/extensions";
import type { JsonSchema } from "../../lib/json-schema";
import { fieldsSchema } from "./deployment";
import { type FieldMeta, getPath, sameJson, setPath } from "./model";

type Obj = Record<string, unknown>;

/** What the org form draws for an {@link OrgOverrideView}. */
export interface OverrideForm {
  schema: JsonSchema;
  value: Obj;
  meta: Record<string, FieldMeta>;
}

/**
 * An org's config (`GET …/overrides`) → the form: every field is overridable and shows the
 * platform's value while the org follows it and the copy's own once there is one; a secret shows
 * whose it is, never a value. While following,
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
    const own = copy;
    const shown = own ? f.org : f.platform;
    fields.push({ path: f.path, secret: f.secret, value: f.secret ? undefined : shown?.value });
    if (!f.secret && shown?.value !== undefined) value = setPath(value, f.path, shown.value);
    const m: FieldMeta = {};
    if (!own && !f.secret) m.platform = f.platform;
    if (f.secret) {
      const set = own ? f.org?.set === true : f.platform.set === true;
      m.secretState = set ? (own ? "own" : "platform") : "unset";
      m.secretSet = own && set;
      if ((!copy && f.platform.set === true) || issued.has(f.path)) required.add(f.path);
    }
    meta[f.path] = m;
  }
  // Without the kernel's schema the form is built from the fields and the required secrets are
  // inferred above; with it, its own `required` decides.
  return { schema: view.schema ?? fieldsSchema(fields, required), value, meta };
}

/**
 * The `PUT …/overrides` `values`: non-secret fields whose value changed against `baseline`
 * (a cleared one is `null`) and secrets that were typed.
 */
export function overrideValues(
  view: OrgOverrideView,
  baseline: unknown,
  value: unknown,
): Record<string, unknown> {
  const values: Obj = {};
  for (const f of view.fields) {
    const now = getPath(value, f.path);
    if (f.secret) {
      if (now !== undefined) values[f.path] = now;
    } else if (!sameJson(getPath(baseline, f.path), now)) values[f.path] = now ?? null;
  }
  return values;
}
