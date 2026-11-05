import type {
  DeploymentConfigField,
  DeploymentConfigView,
  SecretEntry,
} from "../../lib/admin-extensions";
import type { JsonSchema } from "../../lib/json-schema";
import {
  allItemSecretPaths,
  type ConfigNode,
  type ConfigSecretEntry,
  type FieldMeta,
  getPath,
  sameJson,
  setPath,
} from "./model";

/**
 * The deployment config adapter (`GET / PUT /admin/extensions/:name/config`): the view's fields
 * become the form's value and per-field meta (source, secret set / keys, hot); a save sends only
 * the changed, writable field paths (`values`) plus the per-item secret operations
 * (`secretEntries`, spec §4.3).
 */

type Obj = Record<string, unknown>;

/** A field without a schema (an old package not loaded here): its type from its current value. */
function inferred(f: DeploymentConfigField): Obj {
  if (f.secret) return { type: "string", "x-secret": true };
  switch (typeof f.value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    default:
      return f.value === undefined ? { type: "string" } : { "x-unsupported": true };
  }
}

/** A schema built from the field list alone (dot paths become nested objects). */
function fieldsSchema(fields: DeploymentConfigField[]): JsonSchema {
  const root: Obj = { type: "object", properties: {} };
  for (const f of fields) {
    let at = root;
    const segs = f.path.split(".");
    segs.forEach((seg, i) => {
      const props = at.properties as Obj;
      if (i === segs.length - 1) props[seg] = inferred(f);
      else {
        const next = (props[seg] as Obj | undefined) ?? { type: "object", properties: {} };
        props[seg] = next;
        at = next;
      }
    });
  }
  return root;
}

export interface DeploymentForm {
  schema: JsonSchema;
  value: Obj;
  meta: Record<string, FieldMeta>;
}

/** The view → what the form draws: the schema (or one built from the fields), values and meta. */
export function deploymentForm(view: DeploymentConfigView): DeploymentForm {
  let value: Obj = {};
  const meta: Record<string, FieldMeta> = {};
  for (const f of view.fields) {
    if (!f.secret && f.value !== undefined) value = setPath(value, f.path, f.value);
    meta[f.path] = {
      ...(f.readonly && { readonly: f.source }),
      ...(f.secret && { secretSet: f.set === true }),
      ...(f.keys !== undefined && { secretKeys: f.keys }),
      hot: f.hot,
    };
  }
  return { schema: view.schema ?? fieldsSchema(view.fields), value, meta };
}

/**
 * The `PUT` body: writable fields whose value changed against `baseline` (a cleared field is
 * `null`); a secret field is sent only when replaced (its value) or cleared (`null`); records drawn
 * per item are left to `secretEntries`.
 */
export function deploymentBody(
  view: DeploymentConfigView,
  tree: ConfigNode,
  baseline: unknown,
  value: unknown,
  entries: ConfigSecretEntry[],
): { values: Obj; secretEntries: SecretEntry[] } {
  const perItem = allItemSecretPaths(tree);
  const values: Obj = {};
  const writable = new Set<string>();
  for (const f of view.fields) {
    if (f.readonly) continue;
    writable.add(f.path);
    if (perItem.has(f.path)) continue;
    const now = getPath(value, f.path);
    if (f.secret) {
      if (now !== undefined) values[f.path] = now;
      continue;
    }
    if (!sameJson(getPath(baseline, f.path), now)) values[f.path] = now === undefined ? null : now;
  }
  const secretEntries = entries
    .filter((e) => writable.has(e.path))
    .map(
      (e): SecretEntry => ({
        path: e.path,
        key: e.key,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.renameFrom !== undefined && { renameFrom: e.renameFrom }),
      }),
    );
  return { values, secretEntries };
}

/** Saving these values reloads the extension (some changed field is not hot). */
export function reloads(
  view: DeploymentConfigView,
  body: { values: Obj; secretEntries: SecretEntry[] },
): boolean {
  const touched = new Set([...Object.keys(body.values), ...body.secretEntries.map((e) => e.path)]);
  return view.fields.some((f) => !f.hot && touched.has(f.path));
}
