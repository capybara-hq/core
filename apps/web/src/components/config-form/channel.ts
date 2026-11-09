import type { JsonSchema } from "../../lib/json-schema";
import type { FieldMeta } from "./model";
import { orgConfig, orgFormMeta } from "./org";

/**
 * The channel connection adapter (`POST /channels`, `PATCH /channels/:id` `config`): the same
 * whole-object semantics as the org config: an untouched secret is omitted (kept), a cleared one
 * `null`, a replaced one its new value.
 */

/** `secrets: [{ path, set }]` of a connection → per-field meta (none when creating). */
export const channelFormMeta = (
  secrets?: readonly { path: string; set: boolean }[],
): Record<string, FieldMeta> => orgFormMeta(secrets);

/** The form's value as the connection `config`. */
export const channelConfig = (value: unknown): Record<string, unknown> => orgConfig(value);

type Mode = "long_connection" | "webhook";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The top-level fields of a connection schema that carry `x-ui.inboundModes` (channel inbound mode
 * fields spec §2), with their modes; fields without it belong to every mode.
 */
export function inboundModeFields(schema: JsonSchema | null | undefined): Record<string, Mode[]> {
  const out: Record<string, Mode[]> = {};
  const props = isObj(schema?.properties) ? schema.properties : {};
  for (const [key, node] of Object.entries(props)) {
    const modes = isObj(node) && isObj(node["x-ui"]) ? node["x-ui"].inboundModes : undefined;
    if (!Array.isArray(modes)) continue;
    const known = (["long_connection", "webhook"] as const).filter((m) => modes.includes(m));
    if (known.length > 0) out[key] = known;
  }
  return out;
}

/**
 * The connection schema as the form draws it in `mode`: the fields of other modes removed, the
 * fields of this mode required (the kernel refuses them missing). A schema without the hint is
 * returned as it is.
 */
export function channelSchemaForMode(
  schema: JsonSchema | null | undefined,
  mode: Mode,
): JsonSchema | null | undefined {
  const fields = inboundModeFields(schema);
  if (schema == null || Object.keys(fields).length === 0) return schema;
  const props = { ...(schema.properties as Record<string, unknown>) };
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  for (const [key, modes] of Object.entries(fields)) {
    if (modes.includes(mode)) required.add(key);
    else {
      delete props[key];
      required.delete(key);
    }
  }
  return { ...schema, properties: props, required: [...required] };
}

/** The fields `mode` requires that `has` says have no value (the detail page's mode switch). */
export const missingModeFields = (
  schema: JsonSchema | null | undefined,
  mode: Mode,
  has: (field: string) => boolean,
): string[] =>
  Object.entries(inboundModeFields(schema))
    .filter(([key, modes]) => modes.includes(mode) && !has(key))
    .map(([key]) => key);

/** Only the fields `keys` of a connection schema, all required (the mode switch's missing fields). */
export function channelSchemaFields(schema: JsonSchema, keys: readonly string[]): JsonSchema {
  const props = isObj(schema.properties) ? schema.properties : {};
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(props).filter(([k]) => keys.includes(k))),
    required: [...keys],
  };
}
