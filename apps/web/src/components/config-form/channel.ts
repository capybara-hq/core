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
