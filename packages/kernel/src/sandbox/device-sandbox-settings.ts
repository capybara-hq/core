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
 * The old permission value written next to the new keys for replicas of the previous version
 * (their Full switch): `allowed` only when running outside the sandbox is allowed AND the network
 * ceiling is open, else `off`, so an old replica never reads Full where a new one keeps devices on
 * the allowlist. `outside` absent with an open ceiling stays absent (follow the default).
 */
export function legacyPermissionFor(
  outside: OutsideSandboxPermission | undefined,
  ceiling: DeviceNetworkMode | undefined,
): OutsideSandboxPermission | undefined {
  return outside === "off" || ceiling === "allowlist" ? "off" : outside;
}

/**
 * The stored choices of `rows` over every key (fail closed). Without `devicesOutsideSandbox` the
 * old keys are all there is: each converts in full (an `off` also narrows the network ceiling).
 * With it, an old key written in step ({@link legacyPermissionFor} the new keys and the effective
 * ceiling, `configuredCeiling` from the startup config winning over the stored one) says nothing
 * more; one that differs (an old replica wrote it) narrows as a conversion would.
 */
function storedOf(
  rows: Map<string, unknown>,
  log?: Pick<KernelLogger, "warn">,
  configuredCeiling?: DeviceNetworkMode,
): StoredDeviceSandbox {
  const current: StoredDeviceSandbox = {
    outsideSandbox: parseStoredDevicesOutsideSandbox(
      rows.get(DEVICES_OUTSIDE_SANDBOX_SETTING),
      log,
    ),
    network: parseStoredDevicesNetwork(rows.get(DEVICES_NETWORK_SETTING), log),
  };
  const marked = rows.has(DEVICES_OUTSIDE_SANDBOX_SETTING);
  const inStep = legacyPermissionFor(
    current.outsideSandbox.permission,
    configuredCeiling ?? current.network.ceiling,
  );
  let out = current;
  for (const { value } of legacyOf(rows, log)) {
    if (marked && value.outsideSandbox.permission === inStep) continue;
    out = narrowerStoredDeviceSandbox(out, value);
  }
  return out;
}

/** The stored choices, read live (in the caller's transaction when there is one). */
export async function readStoredDeviceSandbox(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
  configuredCeiling?: DeviceNetworkMode,
): Promise<StoredDeviceSandbox> {
  return storedOf(await storedRows(db), log, configuredCeiling);
}

/** The old platform keys still stored (a write then keeps them in step until they are converted). */
export async function legacyPlatformKeysStored(db: KernelSchemaDb): Promise<string[]> {
  return [...(await storedRows(db)).keys()].filter(
    (k) => k === LEGACY_DEVICES_FULL_ACCESS_SETTING || k === LEGACY_DEVICES_AUTO_MODE_SETTING,
  );
}

/** The value an old platform key stores for `permission` (absent: follow the default). */
export const legacyPlatformValue = (
  key: string,
  permission: OutsideSandboxPermission | undefined,
): unknown =>
  key === LEGACY_DEVICES_AUTO_MODE_SETTING
    ? permission === undefined
      ? {}
      : { mode: permission }
    : permission === undefined
      ? {}
      : { permission };

/** The configured network ceiling (it wins over the stored one), or undefined. */
const configuredCeilingOf = (c: ConfiguredDeviceSandbox) =>
  c.sources.networkCeiling !== undefined ? c.networkCeiling : undefined;

/**
 * The platform's effective device sandbox settings with their sources, read live from PG at every
 * use (so a change applies on every replica at once): see {@link resolveDeviceSandboxSettings}.
 */
export async function readDeviceSandboxSettingsView(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
  log?: Pick<KernelLogger, "warn">,
): Promise<DeviceSandboxSettingsView> {
  const configured = configuredDeviceSandbox(config);
  return resolveDeviceSandboxSettings(
    configured,
    await readStoredDeviceSandbox(db, log, configuredCeilingOf(configured)),
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
 * An org's `outsideSandbox` and `deviceNetwork` read over the new and the old keys (fail closed).
 * `deviceNetwork` present (a `{}` follow marker included) means this version wrote the settings:
 * - absent: the old keys are all there is and convert in full (design, "Migration"):
 *   `fullAccess` / `autoMode` -> `outsideSandbox` (invalid: `off`), `cloudNetwork` ->
 *   {@link convertLegacyCloudNetwork}, and an old `off` also narrows the ceiling to the allowlist;
 * - present: an old permission written in step ({@link legacyPermissionFor} `outsideSandbox` and
 *   the org's own ceiling; the platform's ceiling reaches old replicas through the platform's own
 *   old key) and a `cloudNetwork` written in step ({@link legacyCloudNetworkOf}) say nothing more;
 *   one that differs (an old replica wrote it) narrows as a conversion would.
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
  const marked = "deviceNetwork" in stored && stored.deviceNetwork !== undefined;
  if (!marked) {
    const outsideSandbox =
      current === "off" || legacy.includes("off") ? ("off" as const) : (current ?? legacy[0]);
    let deviceNetwork = convertLegacyCloudNetwork(stored.cloudNetwork);
    if (legacy.includes("off")) deviceNetwork = withAllowlistCeiling(deviceNetwork);
    return {
      ...(outsideSandbox !== undefined && { outsideSandbox }),
      ...(deviceNetwork !== undefined && { deviceNetwork }),
    };
  }
  const parsed = DeviceNetworkSettingSchema.safeParse(stored.deviceNetwork);
  let deviceNetwork: DeviceNetworkSetting | undefined = parsed.success
    ? parsed.data
    : invalidDeviceNetwork();
  if (deviceNetwork !== undefined && Object.keys(deviceNetwork).length === 0)
    deviceNetwork = undefined;
  // what the new keys alone would have written in step, before any old key narrows them
  const inStep = legacyPermissionFor(current, deviceNetwork?.ceiling);
  if (
    "cloudNetwork" in stored &&
    canonical(stored.cloudNetwork) !== canonical(legacyCloudNetworkOf(deviceNetwork))
  )
    deviceNetwork = narrowerDeviceNetwork(
      deviceNetwork ?? {},
      convertLegacyCloudNetwork(stored.cloudNetwork),
    );
  let outsideSandbox = current;
  for (const value of legacy) {
    if (value === inStep) continue;
    if (value === "off") {
      outsideSandbox = "off";
      deviceNetwork = withAllowlistCeiling(deviceNetwork);
    } else outsideSandbox ??= value;
  }
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
 * carry {@link legacyPermissionFor} `outsideSandbox` and the org's ceiling, `cloudNetwork` carries
 * {@link legacyCloudNetworkOf} `deviceNetwork`; a value that says nothing removes the old key.
 * `deviceNetwork` cleared is stored as `{}`, the marker that this version wrote the settings.
 */
export function keepOrgLegacyKeysInStep(
  written: Record<string, unknown>,
  stored: Record<string, unknown>,
): void {
  if (!orgLegacyKeysStored(stored)) return;
  const outside = written.outsideSandbox as OutsideSandboxPermission | undefined;
  const network = written.deviceNetwork as DeviceNetworkSetting | undefined;
  const legacy = legacyPermissionFor(outside, network?.ceiling);
  for (const k of ["autoMode", "fullAccess"] as const) {
    if (!(k in stored)) continue;
    if (legacy === undefined) delete written[k];
    else written[k] = legacy;
  }
  if ("cloudNetwork" in stored) {
    const old = legacyCloudNetworkOf(network);
    if (old === undefined) delete written.cloudNetwork;
    else written.cloudNetwork = old;
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

/** What the conversion needs of the startup config: the configured network ceiling. */
export interface PermissionKeyConversionContext {
  configuredCeiling?: DeviceNetworkMode | undefined;
}

/**
 * The conversion of the stored permission keys (design, "Migration"), run inside the permission
 * configuration publication transaction under the platform authority write lock (which excludes
 * every org and device writer; the caller locked the org rows to convert before it,
 * {@link lockOrgsWithStoredPermissionKeys}), at every publication: old keys an old replica writes
 * later are converted too. It stores exactly what every reader saw ({@link storedOf},
 * {@link orgDeviceSandboxOf}), never wider, and removes the old keys:
 * - the deployment settings `devicesAutoMode` / `devicesFullAccess` become `devicesOutsideSandbox`
 *   and `devicesNetwork` (an empty network removes the row);
 * - every org's `autoMode` / `fullAccess` / `cloudNetwork` become `outsideSandbox` and
 *   `deviceNetwork` (absent stays absent: the org follows the platform).
 * Each platform or org whose network an old `off` narrowed to the allowlist is named in one
 * warning, with how to reopen it. Idempotent; never refuses.
 */
export async function convertStoredPermissionKeys(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
  context: PermissionKeyConversionContext = {},
): Promise<void> {
  const rows = await storedRows(db, true);
  const legacy = legacyOf(rows, log);
  if (legacy.length > 0) {
    const converted = storedOf(rows, log, context.configuredCeiling);
    const before = parseStoredDevicesNetwork(rows.get(DEVICES_NETWORK_SETTING));
    const upsert = (key: string, value: unknown) =>
      db
        .insertInto("deployment_settings")
        .values({ key, value: JSON.stringify(value) })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value) }))
        .execute();
    await upsert(DEVICES_OUTSIDE_SANDBOX_SETTING, converted.outsideSandbox);
    if (Object.keys(converted.network).length > 0)
      await upsert(DEVICES_NETWORK_SETTING, converted.network);
    else
      await db
        .deleteFrom("deployment_settings")
        .where("key", "=", DEVICES_NETWORK_SETTING)
        .execute();
    await db
      .deleteFrom("deployment_settings")
      .where("key", "in", [LEGACY_DEVICES_AUTO_MODE_SETTING, LEGACY_DEVICES_FULL_ACCESS_SETTING])
      .execute();
    if (converted.network.ceiling === "allowlist" && before.ceiling !== "allowlist")
      log?.warn(
        "permission configuration conversion: the platform's old Full access off now keeps every device on the allowlist network (devicesNetwork ceiling allowlist); a super admin reopens it in the admin console settings (devicesNetwork.ceiling open)",
        { key: DEVICES_NETWORK_SETTING },
      );
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
    for (const k of ["autoMode", "fullAccess"] as const)
      if (k in stored && !Permission.safeParse(stored[k]).success)
        log?.warn(`org settings: stored ${k} is invalid; it converts to outsideSandbox off`, {
          orgId: org.id,
        });
    const { outsideSandbox, deviceNetwork } = orgDeviceSandboxOf(stored);
    const { autoMode: _a, fullAccess: _f, ...withoutPermission } = stored;
    // the network without the old permission: what an old off narrowed, for the warning
    const was = orgDeviceSandboxOf(withoutPermission).deviceNetwork;
    const { cloudNetwork: _c, outsideSandbox: _o, deviceNetwork: _d, ...rest } = withoutPermission;
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
    if (deviceNetwork?.ceiling === "allowlist" && was?.ceiling !== "allowlist")
      log?.warn(
        `permission configuration conversion: org ${org.id}'s old Full access off now keeps its devices on the allowlist network (deviceNetwork ceiling allowlist); an org admin reopens it in the organization settings (deviceNetwork.ceiling open)`,
        { orgId: org.id },
      );
  }
}
