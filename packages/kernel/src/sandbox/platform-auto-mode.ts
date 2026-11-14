import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { KernelLogger } from "../log.js";

/**
 * The platform's auto-mode switch (auto mode spec §4.3, P-D9): whether a device may run in auto
 * mode. It is both a startup config field (`devices.autoMode`) and a deployment setting
 * ({@link DEVICES_AUTO_MODE_SETTING}), read live at every use: environment > config file / Nacos >
 * the super admin's choice in the admin console > {@link DEVICES_AUTO_MODE_DEFAULT}. A field set in
 * the startup config is read-only in the admin console. An invalid stored value reads as `off` with
 * a warning (fail closed): a mode nobody could set must never widen a device.
 */

export type DevicesAutoMode = "allowed" | "off";

/** The `deployment_settings` key of the super admin's choice. */
export const DEVICES_AUTO_MODE_SETTING = "devicesAutoMode";

/** What a deployment with neither the startup config nor the stored choice says: auto allowed. */
export const DEVICES_AUTO_MODE_DEFAULT: DevicesAutoMode = "allowed";

/** The stored choice: `mode` absent follows the default. */
export const DevicesAutoModeStoredSchema = z
  .object({ mode: z.enum(["allowed", "off"]).optional() })
  .strict();
export type DevicesAutoModeStored = z.infer<typeof DevicesAutoModeStoredSchema>;

/**
 * A change of the stored choice (`PUT /api/v1/admin/settings` `devicesAutoMode`): `mode: null`
 * clears it, back to {@link DEVICES_AUTO_MODE_DEFAULT}.
 */
export const DEVICES_AUTO_MODE_PATCH = z
  .object({ mode: z.enum(["allowed", "off"]).nullable() })
  .strict();
export type DevicesAutoModePatch = z.infer<typeof DEVICES_AUTO_MODE_PATCH>;

/** Where the effective switch comes from. */
export type DevicesAutoModeSource = "env" | "file" | "nacos" | "db" | "default";

/** The admin console's view: the effective mode and where it comes from. */
export interface DevicesAutoModeView {
  mode: DevicesAutoMode;
  source: DevicesAutoModeSource;
}

/**
 * Parses the stored choice: missing -> `{}`; invalid -> `{ mode: "off" }` with a warning, narrower,
 * never wider (the safe direction: auto mode off means sandbox mode).
 */
export function parseStoredDevicesAutoMode(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): DevicesAutoModeStored {
  if (value === undefined) return {};
  const parsed = DevicesAutoModeStoredSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as mode off", { key: DEVICES_AUTO_MODE_SETTING });
  return { mode: "off" };
}

/** The stored choice with `patch` applied (`mode: null` clears it). */
export function applyDevicesAutoModePatch(
  _stored: DevicesAutoModeStored,
  patch: DevicesAutoModePatch,
): DevicesAutoModeStored {
  return patch.mode === null ? {} : { mode: patch.mode };
}

/**
 * The effective switch and its source, pure (the reader below adds the database read). The startup
 * config field is optional and has no schema default, so `configMode !== undefined` means the
 * config source (environment, file or Nacos) sets it: it wins over the stored choice.
 */
export function resolveDevicesAutoMode(
  configMode: DevicesAutoMode | undefined,
  configSource: Exclude<DevicesAutoModeSource, "db" | "default"> | undefined,
  stored: DevicesAutoModeStored,
): DevicesAutoModeView {
  if (configMode !== undefined && configSource !== undefined) {
    return { mode: configMode, source: configSource };
  }
  if (stored.mode !== undefined) return { mode: stored.mode, source: "db" };
  return { mode: DEVICES_AUTO_MODE_DEFAULT, source: "default" };
}

/** The stored choice, read live (in the caller's transaction when there is one). */
export async function readStoredDevicesAutoMode(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<DevicesAutoModeStored> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", DEVICES_AUTO_MODE_SETTING)
    .executeTakeFirst();
  return parseStoredDevicesAutoMode(row?.value, log);
}

/**
 * The platform's effective auto-mode switch, read live from PG at every use (so a change applies on
 * every replica at once): see {@link resolveDevicesAutoMode}.
 */
export async function readDevicesAutoMode(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
  log?: Pick<KernelLogger, "warn">,
): Promise<DevicesAutoModeView> {
  const stored = await readStoredDevicesAutoMode(db, log);
  return resolveDevicesAutoMode(
    config.get().devices.autoMode,
    config.fieldSource("devices.autoMode"),
    stored,
  );
}
