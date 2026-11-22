import { EXTENSION_NAME_RE } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { KernelLogger } from "../log.js";
import type { DeviceSandboxSource } from "../sandbox/device-sandbox-settings.js";

/**
 * The platform's default device provider: the `device-provider@1` extension that makes a person's
 * default device when several coexist. Both a startup config field (`devices.defaultProvider`) and
 * a deployment setting ({@link DEVICES_DEFAULT_PROVIDER_SETTING}), read live at every use:
 * environment > config file / Nacos > the super admin's choice in the admin console > none. An
 * empty string in the startup config means none. A field set in the startup config is read-only in
 * the admin console. An invalid stored value reads as none, with a warning.
 */

/** The `deployment_settings` key of the super admin's choice (stored {@link DevicesDefaultProviderStored}). */
export const DEVICES_DEFAULT_PROVIDER_SETTING = "devicesDefaultProvider";

/** An extension name. */
export const DeviceProviderName = z.string().regex(EXTENSION_NAME_RE, "must be an extension name");

/** The stored choice: `provider` absent follows the default (none). */
export const DevicesDefaultProviderStoredSchema = z
  .object({ provider: DeviceProviderName.optional() })
  .strict();
export type DevicesDefaultProviderStored = z.infer<typeof DevicesDefaultProviderStoredSchema>;

/**
 * A change of the stored choice (`PUT /api/v1/admin/settings` `devicesDefaultProvider`):
 * `provider: null` clears it.
 */
export const DEVICES_DEFAULT_PROVIDER_PATCH = z
  .object({ provider: DeviceProviderName.nullable() })
  .strict();
export type DevicesDefaultProviderPatch = z.infer<typeof DEVICES_DEFAULT_PROVIDER_PATCH>;

/** The admin console's view: the provider in effect (null: none) and where it comes from. */
export interface DevicesDefaultProviderView {
  provider: string | null;
  source: DeviceSandboxSource;
}

type ConfigReader = Pick<KernelConfigService, "get" | "fieldSource">;

/** The stored choice's provider, read live; invalid reads as none with a warning. */
export async function readStoredDefaultProvider(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<string | null | undefined> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", DEVICES_DEFAULT_PROVIDER_SETTING)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const parsed = DevicesDefaultProviderStoredSchema.safeParse(row.value);
  if (parsed.success) return parsed.data.provider ?? null;
  log?.warn("invalid deployment setting; it reads as no default device provider", {
    key: DEVICES_DEFAULT_PROVIDER_SETTING,
  });
  return null;
}

/**
 * The platform's default device provider with its source, read live from PG (in the caller's
 * transaction when there is one): the startup config (`""` reads none), else the stored choice,
 * else none.
 */
export async function readPlatformDefaultProvider(
  cfg: ConfigReader,
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<DevicesDefaultProviderView> {
  // optional chaining: partial config stubs (tests, the CLI) may leave the section out
  const configured = (cfg.get().devices as { defaultProvider?: string } | undefined)
    ?.defaultProvider;
  const source = cfg.fieldSource("devices.defaultProvider");
  if (configured !== undefined && source !== undefined)
    return { provider: configured === "" ? null : configured, source };
  const stored = await readStoredDefaultProvider(db, log);
  if (stored === undefined) return { provider: null, source: "default" };
  return { provider: stored, source: "db" };
}
