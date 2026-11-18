import { sql } from "kysely";
import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { KernelLogger } from "../log.js";

/**
 * The platform's Full permission switch (permission runtime cutover B1, replacing the auto-mode
 * switch): whether a device's owner ceiling may allow Full permission. It is both a startup config
 * field (`devices.fullAccess`) and a deployment setting ({@link DEVICES_FULL_ACCESS_SETTING}), read
 * live at every use: environment > config file / Nacos > the super admin's choice in the admin
 * console > {@link DEVICES_FULL_ACCESS_DEFAULT}. A field set in the startup config is read-only in
 * the admin console. An invalid stored value reads as `off` with a warning (fail closed): a value
 * nobody could set must never widen a device.
 */

export type FullAccessPermission = "allowed" | "off";

/** The `deployment_settings` key of the super admin's choice. */
export const DEVICES_FULL_ACCESS_SETTING = "devicesFullAccess";

/**
 * The key the auto-mode switch was stored under. Only the one-time conversion in the permission
 * configuration publication reads it ({@link convertStoredPermissionKeys}).
 */
export const LEGACY_DEVICES_AUTO_MODE_SETTING = "devicesAutoMode";

/** What a deployment with neither the startup config nor the stored choice says: allowed. */
export const DEVICES_FULL_ACCESS_DEFAULT: FullAccessPermission = "allowed";

const Permission = z.enum(["allowed", "off"]);

/** The stored choice: `permission` absent follows the default. */
export const DevicesFullAccessStoredSchema = z
  .object({ permission: Permission.optional() })
  .strict();
export type DevicesFullAccessStored = z.infer<typeof DevicesFullAccessStoredSchema>;

/**
 * A change of the stored choice (`PUT /api/v1/admin/settings` `devicesFullAccess`): `permission:
 * null` clears it, back to {@link DEVICES_FULL_ACCESS_DEFAULT}.
 */
export const DEVICES_FULL_ACCESS_PATCH = z.object({ permission: Permission.nullable() }).strict();
export type DevicesFullAccessPatch = z.infer<typeof DEVICES_FULL_ACCESS_PATCH>;

/** Where the effective switch comes from. */
export type DevicesFullAccessSource = "env" | "file" | "nacos" | "db" | "default";

/** The admin console's view: the effective permission and where it comes from. */
export interface DevicesFullAccessView {
  permission: FullAccessPermission;
  source: DevicesFullAccessSource;
}

/**
 * Parses a stored choice: missing -> `{}`; invalid -> `{ permission: "off" }` with a warning,
 * narrower, never wider.
 */
export function parseStoredDevicesFullAccess(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): DevicesFullAccessStored {
  if (value === undefined) return {};
  const parsed = DevicesFullAccessStoredSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as Full permission off", {
    key: DEVICES_FULL_ACCESS_SETTING,
  });
  return { permission: "off" };
}

/**
 * Parses a stored old auto-mode choice into the new shape: `{ mode }` maps to `{ permission }`, an
 * empty choice stays empty, an invalid one becomes an explicit `off` with a warning, never absent.
 */
export function parseLegacyStoredDevicesAutoMode(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): DevicesFullAccessStored {
  const parsed = z.object({ mode: Permission.optional() }).strict().safeParse(value);
  if (parsed.success) return parsed.data.mode === undefined ? {} : { permission: parsed.data.mode };
  log?.warn("invalid deployment setting devicesAutoMode; it converts to Full permission off", {
    key: LEGACY_DEVICES_AUTO_MODE_SETTING,
  });
  return { permission: "off" };
}

/** The stored choice with `patch` applied (`permission: null` clears it). */
export function applyDevicesFullAccessPatch(
  _stored: DevicesFullAccessStored,
  patch: DevicesFullAccessPatch,
): DevicesFullAccessStored {
  return patch.permission === null ? {} : { permission: patch.permission };
}

/**
 * The effective switch and its source, pure (the reader below adds the database read). The startup
 * config field is optional and has no schema default, so a defined `configured` value means the
 * config source (environment, file or Nacos) sets it: it wins over the stored choice.
 */
export function resolveDevicesFullAccess(
  configured: FullAccessPermission | undefined,
  configSource: Exclude<DevicesFullAccessSource, "db" | "default"> | undefined,
  stored: DevicesFullAccessStored,
): DevicesFullAccessView {
  if (configured !== undefined && configSource !== undefined) {
    return { permission: configured, source: configSource };
  }
  if (stored.permission !== undefined) return { permission: stored.permission, source: "db" };
  return { permission: DEVICES_FULL_ACCESS_DEFAULT, source: "default" };
}

/**
 * The narrower of two stored choices: `off` when either says off; otherwise an explicit value
 * beats an absent one only when it is narrower, so two non-off choices read as `a`.
 */
export const narrowerStoredFullAccess = (
  a: DevicesFullAccessStored,
  b: DevicesFullAccessStored,
): DevicesFullAccessStored =>
  a.permission === "off" || b.permission === "off" ? { permission: "off" } : a;

/**
 * The stored choice, read live (in the caller's transaction when there is one). It reads both
 * keys and takes the narrower (fail closed): until the permission configuration publication
 * converts an old `devicesAutoMode` ({@link convertStoredPermissionKeys}; a mismatch window
 * before activation keeps it), its off is never lost. The old key is no public input.
 */
export async function readStoredDevicesFullAccess(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<DevicesFullAccessStored> {
  const rows = await db
    .selectFrom("deployment_settings")
    .select(["key", "value"])
    .where("key", "in", [DEVICES_FULL_ACCESS_SETTING, LEGACY_DEVICES_AUTO_MODE_SETTING])
    .execute();
  const current = rows.find((r) => r.key === DEVICES_FULL_ACCESS_SETTING);
  const legacy = rows.find((r) => r.key === LEGACY_DEVICES_AUTO_MODE_SETTING);
  const stored = parseStoredDevicesFullAccess(current?.value, log);
  return legacy === undefined
    ? stored
    : narrowerStoredFullAccess(stored, parseLegacyStoredDevicesAutoMode(legacy.value, log));
}

/** Whether the old key is still stored (a write then keeps it in step until it is converted). */
export async function legacyDevicesAutoModeStored(db: KernelSchemaDb): Promise<boolean> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("key")
    .where("key", "=", LEGACY_DEVICES_AUTO_MODE_SETTING)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The org's stored Full switch read over both keys (fail closed): `fullAccess` and an old
 * `autoMode` the publication has not converted yet (an invalid old value reads as off); the
 * narrower wins, an absent old key leaves `fullAccess` as it is.
 */
export function narrowedOrgFullAccess(
  fullAccess: FullAccessPermission | undefined,
  rawLegacy: unknown,
): FullAccessPermission | undefined {
  if (rawLegacy === undefined) return fullAccess;
  const legacy = Permission.safeParse(rawLegacy);
  return fullAccess === "off" || !legacy.success || legacy.data === "off" ? "off" : fullAccess;
}

/**
 * The platform's effective Full switch, read live from PG at every use (so a change applies on
 * every replica at once): see {@link resolveDevicesFullAccess}.
 */
export async function readDevicesFullAccess(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
  log?: Pick<KernelLogger, "warn">,
): Promise<DevicesFullAccessView> {
  const stored = await readStoredDevicesFullAccess(db, log);
  return resolveDevicesFullAccess(
    config.get().devices.fullAccess,
    config.fieldSource("devices.fullAccess"),
    stored,
  );
}

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Two stored choices say the same thing. */
const same = (a: DevicesFullAccessStored, b: DevicesFullAccessStored) =>
  a.permission === b.permission;

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
    .where(sql<boolean>`settings ? ${"autoMode"}`)
    .orderBy("id")
    // the conversion updates only `settings`, a non-key column: the org row lock's mode (OrgLock),
    // which leaves foreign key checks against the org (FOR KEY SHARE) unblocked
    .forNoKeyUpdate()
    .execute();
}

/**
 * The one-time conversion of the stored permission keys (B1), run only inside the permission
 * configuration publication transaction under the platform authority write lock (which excludes
 * every org and device writer; the caller locked the org rows to convert before it,
 * {@link lockOrgsWithStoredPermissionKeys}): the deployment setting `devicesAutoMode` becomes
 * `devicesFullAccess`, and every org's `autoMode` becomes `fullAccess` (absent stays absent:
 * the org follows the platform). Values convert exactly; an invalid old value converts to an
 * explicit `off` with a warning. An old and a new value that differ stop the conversion (the
 * caller's transaction rolls back): never pick the wider one. Idempotent.
 */
export async function convertStoredPermissionKeys(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<void> {
  const rows = await db
    .selectFrom("deployment_settings")
    .select(["key", "value"])
    .where("key", "in", [LEGACY_DEVICES_AUTO_MODE_SETTING, DEVICES_FULL_ACCESS_SETTING])
    .forUpdate()
    .execute();
  const old = rows.find((r) => r.key === LEGACY_DEVICES_AUTO_MODE_SETTING);
  const current = rows.find((r) => r.key === DEVICES_FULL_ACCESS_SETTING);
  if (old !== undefined) {
    const converted = parseLegacyStoredDevicesAutoMode(old.value, log);
    if (current !== undefined && !same(converted, parseStoredDevicesFullAccess(current.value, log)))
      throw new Error(
        `Stored deployment settings devicesAutoMode and devicesFullAccess differ; remove one of them before converting the permission configuration`,
      );
    if (current === undefined)
      await db
        .insertInto("deployment_settings")
        .values({ key: DEVICES_FULL_ACCESS_SETTING, value: JSON.stringify(converted) })
        .execute();
    await db
      .deleteFrom("deployment_settings")
      .where("key", "=", LEGACY_DEVICES_AUTO_MODE_SETTING)
      .execute();
  }
  const orgs = await db
    .selectFrom("orgs")
    .select(["id", "settings"])
    .where(sql<boolean>`settings ? ${"autoMode"}`)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  for (const org of orgs) {
    const { autoMode, ...rest } = asObject(org.settings);
    const parsed = Permission.safeParse(autoMode);
    if (!parsed.success)
      log?.warn("org settings: stored autoMode is invalid; it converts to fullAccess off", {
        orgId: org.id,
      });
    const value = parsed.success ? parsed.data : "off";
    if ("fullAccess" in rest) {
      const existing = Permission.safeParse(rest.fullAccess);
      if (!existing.success || existing.data !== value)
        throw new Error(
          `Org ${org.id} stores autoMode and fullAccess that differ; remove one of them before converting the permission configuration`,
        );
    }
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ ...rest, fullAccess: value }) })
      .where("id", "=", org.id)
      .execute();
  }
}
