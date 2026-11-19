import { sql } from "kysely";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { KernelLogger } from "../log.js";
import {
  convertLegacyCloudNetwork,
  type DeviceNetworkSetting,
  DeviceNetworkSettingSchema,
  invalidDeviceNetwork,
  legacyCloudNetworkOf,
  narrowerDeviceNetwork,
  withAllowlistCeiling,
} from "../orgs/device-network-setting.js";
import type { DeviceNetworkMode, DeviceSandboxSettings } from "./device-sandbox.js";

/**
 * The platform's device sandbox settings (approval-only profiles design, "Settings model"): the
 * outside-sandbox ceiling (`devices.outsideSandbox`) and the sandbox network's default and ceiling
 * (`devices.network.default`, `devices.network.ceiling`). Each is both a startup config field and
 * a deployment setting ({@link DEVICES_OUTSIDE_SANDBOX_SETTING}, {@link DEVICES_NETWORK_SETTING}),
 * read live at every use: environment > config file / Nacos > the super admin's choice in the admin
 * console > {@link DEVICE_SANDBOX_DEFAULTS}. A field set in the startup config is read-only in the
 * admin console. An invalid stored value reads narrower with a warning (fail closed): `off`, and
 * the allowlist.
 *
 * Before 0.1.0 the old keys are converted, never aliased: the deployment settings
 * `devicesFullAccess` and `devicesAutoMode` and the org keys `fullAccess`, `autoMode` and
 * `cloudNetwork` are read (the narrower wins) until the permission configuration publication
 * converts them ({@link convertStoredPermissionKeys}); writes keep a still stored old key in step
 * for replicas of the previous version. An old `off` kept every device on the allowlist, so it
 * converts to `outsideSandbox: off` plus an allowlist network ceiling (never wider).
 */

export type OutsideSandboxPermission = "allowed" | "off";

/** The `deployment_settings` key of the super admin's outside-sandbox choice. */
export const DEVICES_OUTSIDE_SANDBOX_SETTING = "devicesOutsideSandbox";

/** The `deployment_settings` key of the super admin's network choice. */
export const DEVICES_NETWORK_SETTING = "devicesNetwork";

/** The old key of the outside-sandbox choice (B1's Full switch), read only to convert it. */
export const LEGACY_DEVICES_FULL_ACCESS_SETTING = "devicesFullAccess";

/** The key B1 converted (the auto-mode switch), read only to convert it. */
export const LEGACY_DEVICES_AUTO_MODE_SETTING = "devicesAutoMode";

/** The org settings keys the publication converts. */
const LEGACY_ORG_KEYS = ["autoMode", "fullAccess", "cloudNetwork"] as const;

/** What a deployment with neither the startup config nor the stored choice says. */
export const DEVICE_SANDBOX_DEFAULTS: DeviceSandboxSettings = {
  outsideSandbox: "allowed",
  network: { default: "open", ceiling: "open" },
};

const Permission = z.enum(["allowed", "off"]);
const Mode = z.enum(["open", "allowlist"]) satisfies z.ZodType<DeviceNetworkMode>;

/** The stored outside-sandbox choice: `permission` absent follows the default. */
export const DevicesOutsideSandboxStoredSchema = z
  .object({ permission: Permission.optional() })
  .strict();
export type DevicesOutsideSandboxStored = z.infer<typeof DevicesOutsideSandboxStoredSchema>;

/** The stored network choice: a field absent follows the default. */
export const DevicesNetworkStoredSchema = z
  .object({ default: Mode.optional(), ceiling: Mode.optional() })
  .strict();
export type DevicesNetworkStored = z.infer<typeof DevicesNetworkStoredSchema>;

/** Both stored choices. */
export interface StoredDeviceSandbox {
  outsideSandbox: DevicesOutsideSandboxStored;
  network: DevicesNetworkStored;
}

/**
 * A change of the stored outside-sandbox choice (`PUT /api/v1/admin/settings`
 * `devicesOutsideSandbox`): `permission: null` clears it, back to the default `allowed`.
 */
export const DEVICES_OUTSIDE_SANDBOX_PATCH = z
  .object({ permission: Permission.nullable() })
  .strict();
export type DevicesOutsideSandboxPatch = z.infer<typeof DEVICES_OUTSIDE_SANDBOX_PATCH>;

/**
 * A change of the stored network choice (`devicesNetwork`): each given field replaces the stored
 * one, null clears it (back to the default `open`); at least one field.
 */
export const DEVICES_NETWORK_PATCH = z
  .object({ default: Mode.nullable().optional(), ceiling: Mode.nullable().optional() })
  .strict()
  .refine((p) => p.default !== undefined || p.ceiling !== undefined, {
    message: "give default, ceiling or both",
  });
export type DevicesNetworkPatch = z.infer<typeof DEVICES_NETWORK_PATCH>;

/** Where an effective value comes from. */
export type DeviceSandboxSource = "env" | "file" | "nacos" | "db" | "default";
type ConfigSource = Exclude<DeviceSandboxSource, "db" | "default">;

/** The admin console's view of the outside-sandbox ceiling. */
export interface DevicesOutsideSandboxView {
  permission: OutsideSandboxPermission;
  source: DeviceSandboxSource;
}

/** The admin console's view of the network: effective values (the default within the ceiling). */
export interface DevicesNetworkView {
  default: DeviceNetworkMode;
  ceiling: DeviceNetworkMode;
  sources: { default: DeviceSandboxSource; ceiling: DeviceSandboxSource };
}

export interface DeviceSandboxSettingsView {
  outsideSandbox: DevicesOutsideSandboxView;
  network: DevicesNetworkView;
}

/** The startup config's values and where each comes from (undefined: not set there). */
export interface ConfiguredDeviceSandbox {
  outsideSandbox?: OutsideSandboxPermission | undefined;
  networkDefault?: DeviceNetworkMode | undefined;
  networkCeiling?: DeviceNetworkMode | undefined;
  sources: {
    outsideSandbox?: ConfigSource | undefined;
    networkDefault?: ConfigSource | undefined;
    networkCeiling?: ConfigSource | undefined;
  };
}

/**
 * Parses a stored outside-sandbox choice: missing -> `{}`; invalid -> `{ permission: "off" }` with
 * a warning, narrower, never wider.
 */
export function parseStoredDevicesOutsideSandbox(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): DevicesOutsideSandboxStored {
  if (value === undefined) return {};
  const parsed = DevicesOutsideSandboxStoredSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as running outside the sandbox off", {
    key: DEVICES_OUTSIDE_SANDBOX_SETTING,
  });
  return { permission: "off" };
}

/**
 * Parses a stored network choice: missing -> `{}`; invalid -> the allowlist for both with a
 * warning, narrower, never wider.
 */
export function parseStoredDevicesNetwork(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): DevicesNetworkStored {
  if (value === undefined) return {};
  const parsed = DevicesNetworkStoredSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as the allowlist", {
    key: DEVICES_NETWORK_SETTING,
  });
  return { default: "allowlist", ceiling: "allowlist" };
}

/** What an old outside-sandbox value converts to: `off` also narrows the network ceiling. */
const ofLegacyPermission = (
  permission: OutsideSandboxPermission | undefined,
): StoredDeviceSandbox =>
  permission === undefined
    ? { outsideSandbox: {}, network: {} }
    : {
        outsideSandbox: { permission },
        network: permission === "off" ? { ceiling: "allowlist" } : {},
      };

/**
 * Converts a stored old `devicesFullAccess` (`{ permission }`): the same permission, and an `off`
 * also limits the network ceiling to the allowlist; an invalid value converts to `off` with a
 * warning, never absent.
 */
export function parseLegacyStoredDevicesFullAccess(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): StoredDeviceSandbox {
  const parsed = DevicesOutsideSandboxStoredSchema.safeParse(value);
  if (parsed.success) return ofLegacyPermission(parsed.data.permission);
  log?.warn("invalid deployment setting devicesFullAccess; it converts to off", {
    key: LEGACY_DEVICES_FULL_ACCESS_SETTING,
  });
  return ofLegacyPermission("off");
}

/** Converts a stored old `devicesAutoMode` (`{ mode }`) like {@link parseLegacyStoredDevicesFullAccess}. */
export function parseLegacyStoredDevicesAutoMode(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): StoredDeviceSandbox {
  const parsed = z.object({ mode: Permission.optional() }).strict().safeParse(value);
  if (parsed.success) return ofLegacyPermission(parsed.data.mode);
  log?.warn("invalid deployment setting devicesAutoMode; it converts to off", {
    key: LEGACY_DEVICES_AUTO_MODE_SETTING,
  });
  return ofLegacyPermission("off");
}

/** The stored outside-sandbox choice with `patch` applied (`permission: null` clears it). */
export function applyDevicesOutsideSandboxPatch(
  _stored: DevicesOutsideSandboxStored,
  patch: DevicesOutsideSandboxPatch,
): DevicesOutsideSandboxStored {
  return patch.permission === null ? {} : { permission: patch.permission };
}

/** The stored network choice with `patch` applied (a null field clears it). */
export function applyDevicesNetworkPatch(
  stored: DevicesNetworkStored,
  patch: DevicesNetworkPatch,
): DevicesNetworkStored {
  const next: DevicesNetworkStored = { ...stored };
  for (const field of ["default", "ceiling"] as const) {
    const value = patch[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  return next;
}

const narrowerMode = (a: DeviceNetworkMode | undefined, b: DeviceNetworkMode | undefined) =>
  a === "allowlist" || b === "allowlist" ? ("allowlist" as const) : (a ?? b);

/**
 * The narrower of two stored choices, field by field: `off` / `allowlist` when either says so;
 * otherwise `a`'s value, else `b`'s (an absent value follows the default, the widest, so `allowed`
 * or `open` over absent says the same and is kept, as a conversion must be exact).
 */
export function narrowerStoredDeviceSandbox(
  a: StoredDeviceSandbox,
  b: StoredDeviceSandbox,
): StoredDeviceSandbox {
  const permission =
    a.outsideSandbox.permission === "off" || b.outsideSandbox.permission === "off"
      ? "off"
      : (a.outsideSandbox.permission ?? b.outsideSandbox.permission);
  const def = narrowerMode(a.network.default, b.network.default);
  const ceiling = narrowerMode(a.network.ceiling, b.network.ceiling);
  return {
    outsideSandbox: permission === undefined ? {} : { permission },
    network: {
      ...(def !== undefined && { default: def }),
      ...(ceiling !== undefined && { ceiling }),
    },
  };
}

/**
 * The effective settings and their sources, pure (the reader below adds the database read). The
 * startup config fields are optional with no schema default, so a defined value with a source
 * means the config sets it: it wins over the stored choice. The effective default never exceeds
 * the effective ceiling (the narrower of the two is shown and applied).
 */
export function resolveDeviceSandboxSettings(
  configured: ConfiguredDeviceSandbox,
  stored: StoredDeviceSandbox,
): DeviceSandboxSettingsView {
  const pick = <T>(
    value: T | undefined,
    source: ConfigSource | undefined,
    fromDb: T | undefined,
    fallback: T,
  ): { value: T; source: DeviceSandboxSource } =>
    value !== undefined && source !== undefined
      ? { value, source }
      : fromDb !== undefined
        ? { value: fromDb, source: "db" }
        : { value: fallback, source: "default" };
  const outside = pick(
    configured.outsideSandbox,
    configured.sources.outsideSandbox,
    stored.outsideSandbox.permission,
    DEVICE_SANDBOX_DEFAULTS.outsideSandbox,
  );
  const ceiling = pick(
    configured.networkCeiling,
    configured.sources.networkCeiling,
    stored.network.ceiling,
    DEVICE_SANDBOX_DEFAULTS.network.ceiling,
  );
  const def = pick(
    configured.networkDefault,
    configured.sources.networkDefault,
    stored.network.default,
    DEVICE_SANDBOX_DEFAULTS.network.default,
  );
  return {
    outsideSandbox: { permission: outside.value, source: outside.source },
    network: {
      default: ceiling.value === "allowlist" ? "allowlist" : def.value,
      ceiling: ceiling.value,
      sources: { default: def.source, ceiling: ceiling.source },
    },
  };
}

/** The plain settings of a view. */
export const deviceSandboxSettingsOf = (
  view: DeviceSandboxSettingsView,
): DeviceSandboxSettings => ({
  outsideSandbox: view.outsideSandbox.permission,
  network: { default: view.network.default, ceiling: view.network.ceiling },
});

/** The startup config's values and sources. */
export function configuredDeviceSandbox(
  config: Pick<KernelConfigService, "get" | "fieldSource">,
): ConfiguredDeviceSandbox {
  // optional chaining: partial config stubs (tests, the CLI) may leave the section out
  const d = config.get().devices as Partial<KernelConfig["devices"]> | undefined;
  return {
    outsideSandbox: d?.outsideSandbox,
    networkDefault: d?.network?.default,
    networkCeiling: d?.network?.ceiling,
    sources: {
      outsideSandbox: config.fieldSource("devices.outsideSandbox"),
      networkDefault: config.fieldSource("devices.network.default"),
      networkCeiling: config.fieldSource("devices.network.ceiling"),
    },
  };
}

/** The stored platform rows, by key. */
async function storedRows(db: KernelSchemaDb, forUpdate = false): Promise<Map<string, unknown>> {
  let q = db
    .selectFrom("deployment_settings")
    .select(["key", "value"])
    .where("key", "in", [
      DEVICES_OUTSIDE_SANDBOX_SETTING,
      DEVICES_NETWORK_SETTING,
      LEGACY_DEVICES_FULL_ACCESS_SETTING,
      LEGACY_DEVICES_AUTO_MODE_SETTING,
    ]);
  if (forUpdate) q = q.forUpdate();
  const rows = await q.execute();
  return new Map(rows.map((r) => [r.key, r.value as unknown]));
}

/** The old platform keys of `rows`, each converted. */
function legacyOf(
  rows: Map<string, unknown>,
  log?: Pick<KernelLogger, "warn">,
): { key: string; value: StoredDeviceSandbox }[] {
  const out: { key: string; value: StoredDeviceSandbox }[] = [];
  if (rows.has(LEGACY_DEVICES_AUTO_MODE_SETTING))
    out.push({
      key: LEGACY_DEVICES_AUTO_MODE_SETTING,
      value: parseLegacyStoredDevicesAutoMode(rows.get(LEGACY_DEVICES_AUTO_MODE_SETTING), log),
    });
  if (rows.has(LEGACY_DEVICES_FULL_ACCESS_SETTING))
    out.push({
      key: LEGACY_DEVICES_FULL_ACCESS_SETTING,
      value: parseLegacyStoredDevicesFullAccess(rows.get(LEGACY_DEVICES_FULL_ACCESS_SETTING), log),
    });
  return out;
}

/**
 * The stored choices of `rows` over every key (fail closed): the new keys, narrowed by the old
 * keys still stored. An old `off` narrows the network ceiling only while no network choice is
 * stored or while it disagrees with the new key (an old replica wrote it): a network chosen in
 * step with it already holds that narrowing, and is never overridden.
 */
function storedOf(
  rows: Map<string, unknown>,
  log?: Pick<KernelLogger, "warn">,
): StoredDeviceSandbox {
  const current: StoredDeviceSandbox = {
    outsideSandbox: parseStoredDevicesOutsideSandbox(
      rows.get(DEVICES_OUTSIDE_SANDBOX_SETTING),
      log,
    ),
    network: parseStoredDevicesNetwork(rows.get(DEVICES_NETWORK_SETTING), log),
  };
  let out = current;
  for (const { value } of legacyOf(rows, log)) {
    const diverged =
      !rows.has(DEVICES_NETWORK_SETTING) ||
      value.outsideSandbox.permission !== current.outsideSandbox.permission;
    out = narrowerStoredDeviceSandbox(
      out,
      diverged ? value : { outsideSandbox: value.outsideSandbox, network: {} },
    );
  }
  return out;
}

/** The stored choices, read live (in the caller's transaction when there is one). */
export async function readStoredDeviceSandbox(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<StoredDeviceSandbox> {
  return storedOf(await storedRows(db), log);
}

/** The old platform keys still stored (a write then keeps them in step until they are converted). */
export async function legacyPlatformKeysStored(db: KernelSchemaDb): Promise<string[]> {
  return [...(await storedRows(db)).keys()].filter(
    (k) => k === LEGACY_DEVICES_FULL_ACCESS_SETTING || k === LEGACY_DEVICES_AUTO_MODE_SETTING,
  );
}

/** Whether a network choice is stored. */
export async function devicesNetworkStored(db: KernelSchemaDb): Promise<boolean> {
  return (await storedRows(db)).has(DEVICES_NETWORK_SETTING);
}

/**
 * The platform's effective device sandbox settings with their sources, read live from PG at every
 * use (so a change applies on every replica at once): see {@link resolveDeviceSandboxSettings}.
 */
export async function readDeviceSandboxSettingsView(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
  log?: Pick<KernelLogger, "warn">,
): Promise<DeviceSandboxSettingsView> {
  return resolveDeviceSandboxSettings(
    configuredDeviceSandbox(config),
    await readStoredDeviceSandbox(db, log),
  );
}

/** The platform's effective device sandbox settings (the layer `effectiveDeviceSandbox` takes). */
export async function readDeviceSandboxSettings(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
  log?: Pick<KernelLogger, "warn">,
): Promise<DeviceSandboxSettings> {
  return deviceSandboxSettingsOf(await readDeviceSandboxSettingsView(db, config, log));
}

/** An org's stored device sandbox keys, as every reader sees them. */
export interface OrgDeviceSandboxStored {
  outsideSandbox?: OutsideSandboxPermission | undefined;
  deviceNetwork?: DeviceNetworkSetting | undefined;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** JSON with object keys sorted (PG's jsonb reorders them), for comparing stored values. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

/** An old org permission value converted: invalid reads as `off`. */
const legacyOrgPermission = (v: unknown): OutsideSandboxPermission => {
  const parsed = Permission.safeParse(v);
  return parsed.success ? parsed.data : "off";
};

/**
 * An org's `outsideSandbox` and `deviceNetwork` read over the new and the old keys (fail closed):
 * - `outsideSandbox`: the narrower of it and the old `fullAccess` / `autoMode` still stored (an
 *   invalid value reads as `off`).
 * - `deviceNetwork`: the stored value (invalid: {@link invalidDeviceNetwork}; an empty object, the
 *   marker a write leaves while old keys are stored, follows the platform); an old `cloudNetwork`
 *   converted ({@link convertLegacyCloudNetwork}) when there is none, or narrowing it when it is not
 *   the one written in step ({@link legacyCloudNetworkOf}); and an old `off` narrows the ceiling to
 *   the allowlist when there is no `deviceNetwork` or when the old value disagrees with
 *   `outsideSandbox` (an old replica wrote it).
 */
export function orgDeviceSandboxOf(raw: unknown): OrgDeviceSandboxStored {
  const stored = asObject(raw);
  const parsedOutside = Permission.optional().safeParse(stored.outsideSandbox);
  const current: OutsideSandboxPermission | undefined = parsedOutside.success
    ? parsedOutside.data
    : "off";
  const legacy = (["autoMode", "fullAccess"] as const)
    .filter((k) => k in stored)
    .map((k) => legacyOrgPermission(stored[k]));
  const outsideSandbox =
    current === "off" || legacy.includes("off") ? ("off" as const) : (current ?? legacy[0]);
  const hasNetwork = "deviceNetwork" in stored && stored.deviceNetwork !== undefined;
  let deviceNetwork: DeviceNetworkSetting | undefined;
  if (hasNetwork) {
    const parsed = DeviceNetworkSettingSchema.safeParse(stored.deviceNetwork);
    deviceNetwork = parsed.success ? parsed.data : invalidDeviceNetwork();
    if (deviceNetwork !== undefined && Object.keys(deviceNetwork).length === 0)
      deviceNetwork = undefined;
    if (
      "cloudNetwork" in stored &&
      canonical(stored.cloudNetwork) !== canonical(legacyCloudNetworkOf(deviceNetwork))
    )
      deviceNetwork = narrowerDeviceNetwork(
        deviceNetwork ?? {},
        convertLegacyCloudNetwork(stored.cloudNetwork),
      );
  } else if ("cloudNetwork" in stored) {
    deviceNetwork = convertLegacyCloudNetwork(stored.cloudNetwork);
  }
  const legacyOff = legacy.includes("off");
  if (legacyOff && (!hasNetwork || current !== "off"))
    deviceNetwork = withAllowlistCeiling(deviceNetwork);
  return {
    ...(outsideSandbox !== undefined && { outsideSandbox }),
    ...(deviceNetwork !== undefined && { deviceNetwork }),
  };
}

/** Whether an org's stored settings still hold an old permission key. */
export const orgLegacyKeysStored = (raw: unknown): boolean =>
  LEGACY_ORG_KEYS.some((k) => k in asObject(raw));

/**
 * The old org keys written next to the new ones while any of them is still stored (`written` is
 * the settings object about to be stored; `stored` the one it replaces): `fullAccess` / `autoMode`
 * carry `outsideSandbox`, `cloudNetwork` carries {@link legacyCloudNetworkOf} `deviceNetwork`; a
 * cleared value removes the old key. `deviceNetwork` cleared is stored as `{}`, so an old `off`
 * left in step is not read as a network narrowing the person removed.
 */
export function keepOrgLegacyKeysInStep(
  written: Record<string, unknown>,
  stored: Record<string, unknown>,
): void {
  if (!orgLegacyKeysStored(stored)) return;
  const outside = written.outsideSandbox as OutsideSandboxPermission | undefined;
  const network = written.deviceNetwork as DeviceNetworkSetting | undefined;
  for (const k of ["autoMode", "fullAccess"] as const) {
    if (!(k in stored)) continue;
    if (outside === undefined) delete written[k];
    else written[k] = outside;
  }
  if ("cloudNetwork" in stored) {
    const legacy = legacyCloudNetworkOf(network);
    if (legacy === undefined) delete written.cloudNetwork;
    else written.cloudNetwork = legacy;
  }
  if (network === undefined) written.deviceNetwork = {};
}

/**
 * Locks the org rows {@link convertStoredPermissionKeys} would convert, in id order, before the
 * caller takes the platform authority write lock: the global lock order puts the org row before
 * the permission authority locks (a fenced prelude holds an org row while it waits for its shared
 * platform lock). The conversion itself then finds its rows already held.
 */
export async function lockOrgsWithStoredPermissionKeys(db: KernelSchemaDb): Promise<void> {
  await db
    .selectFrom("orgs")
    .select("id")
    .where(sql<boolean>`settings ?| ${sql.val([...LEGACY_ORG_KEYS])}::text[]`)
    .orderBy("id")
    // the conversion updates only `settings`, a non-key column: the org row lock's mode (OrgLock),
    // which leaves foreign key checks against the org (FOR KEY SHARE) unblocked
    .forNoKeyUpdate()
    .execute();
}

/**
 * The one-time conversion of the stored permission keys (design, "Migration"), run only inside the
 * permission configuration publication transaction under the platform authority write lock (which
 * excludes every org and device writer; the caller locked the org rows to convert before it,
 * {@link lockOrgsWithStoredPermissionKeys}):
 * - the deployment settings `devicesAutoMode` and `devicesFullAccess` become
 *   `devicesOutsideSandbox`, and an old `off` also stores the allowlist network ceiling
 *   (`devicesNetwork`) unless a network choice is stored;
 * - every org's `autoMode` / `fullAccess` becomes `outsideSandbox`, and `cloudNetwork` becomes
 *   `deviceNetwork` ({@link orgDeviceSandboxOf}: absent stays absent, the org follows the platform).
 * Values convert exactly, never wider; an invalid old value converts to `off` with a warning. Old
 * and new permission values that differ stop the conversion (the caller's transaction rolls back):
 * never pick the wider one. Idempotent.
 */
export async function convertStoredPermissionKeys(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<void> {
  const rows = await storedRows(db, true);
  const legacy = legacyOf(rows, log);
  if (legacy.length > 0) {
    const permissions = new Set(legacy.map((l) => l.value.outsideSandbox.permission));
    if (rows.has(DEVICES_OUTSIDE_SANDBOX_SETTING))
      permissions.add(
        parseStoredDevicesOutsideSandbox(rows.get(DEVICES_OUTSIDE_SANDBOX_SETTING), log).permission,
      );
    if (permissions.size > 1)
      throw new Error(
        `Stored deployment settings ${[
          ...legacy.map((l) => l.key),
          ...(rows.has(DEVICES_OUTSIDE_SANDBOX_SETTING) ? [DEVICES_OUTSIDE_SANDBOX_SETTING] : []),
        ].join(
          ", ",
        )} differ; remove all but one of them before converting the permission configuration`,
      );
    const converted = storedOf(rows, log);
    const upsert = (key: string, value: unknown) =>
      db
        .insertInto("deployment_settings")
        .values({ key, value: JSON.stringify(value) })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value) }))
        .execute();
    await upsert(DEVICES_OUTSIDE_SANDBOX_SETTING, converted.outsideSandbox);
    if (!rows.has(DEVICES_NETWORK_SETTING) && Object.keys(converted.network).length > 0)
      await upsert(DEVICES_NETWORK_SETTING, converted.network);
    await db
      .deleteFrom("deployment_settings")
      .where("key", "in", [LEGACY_DEVICES_AUTO_MODE_SETTING, LEGACY_DEVICES_FULL_ACCESS_SETTING])
      .execute();
  }
  const orgs = await db
    .selectFrom("orgs")
    .select(["id", "settings"])
    .where(sql<boolean>`settings ?| ${sql.val([...LEGACY_ORG_KEYS])}::text[]`)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  for (const org of orgs) {
    const stored = asObject(org.settings);
    const values = new Set<unknown>();
    for (const k of ["autoMode", "fullAccess"] as const) {
      if (!(k in stored)) continue;
      if (!Permission.safeParse(stored[k]).success)
        log?.warn(`org settings: stored ${k} is invalid; it converts to outsideSandbox off`, {
          orgId: org.id,
        });
      values.add(legacyOrgPermission(stored[k]));
    }
    if (values.size > 0 && "outsideSandbox" in stored)
      values.add(Permission.safeParse(stored.outsideSandbox).data ?? "off");
    if (values.size > 1)
      throw new Error(
        `Org ${org.id} stores autoMode, fullAccess and outsideSandbox values that differ; remove all but one of them before converting the permission configuration`,
      );
    const { outsideSandbox, deviceNetwork } = orgDeviceSandboxOf(stored);
    const {
      autoMode: _a,
      fullAccess: _f,
      cloudNetwork: _c,
      outsideSandbox: _o,
      deviceNetwork: _d,
      ...rest
    } = stored;
    await db
      .updateTable("orgs")
      .set({
        settings: JSON.stringify({
          ...rest,
          ...(outsideSandbox !== undefined && { outsideSandbox }),
          ...(deviceNetwork !== undefined && { deviceNetwork }),
        }),
      })
      .where("id", "=", org.id)
      .execute();
  }
}
