import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { KernelLogger } from "../log.js";

/**
 * The governance settings of file sharing (file sharing spec §8) and the HTML rendering CDN
 * allowlist (§4). The platform's external sharing switch and the share expiry maximum are both a
 * startup config field (`sharing.external`, `sharing.maxExpiryDays`) and a deployment setting,
 * read live at every use: environment > config file / Nacos > the super admin's choice in the
 * admin console > the default. A field set in the startup config is read-only in the admin
 * console. An invalid stored value fails closed: external sharing reads as `deny`, the expiry
 * maximum as {@link SHARE_MAX_EXPIRY_DEFAULT}, both with a warning.
 */

/** The `deployment_settings` key of the platform's external sharing switch (`"allow" | "deny"`). */
export const EXTERNAL_SHARING_SETTING = "externalSharing";

/** The `deployment_settings` key of the longest expiry a share may take, in days (1..365). */
export const SHARE_MAX_EXPIRY_SETTING = "shareMaxExpiryDays";

/** The share expiry maximum when neither the startup config nor the admin console sets it. */
export const SHARE_MAX_EXPIRY_DEFAULT = 30;

/** The external sharing switch when neither the startup config nor the admin console sets it. */
export const EXTERNAL_SHARING_DEFAULT = "deny" as const;

/** The `deployment_settings` key of the CDN allowlist (also a key of `DEPLOYMENT_SETTINGS`). */
export const HTML_CDN_ALLOWLIST_SETTING = "htmlRenderCdnAllowlist";

export const ExternalSharingValue = z.enum(["allow", "deny"]);
export const ShareMaxExpiryDays = z.number().int().min(1).max(365);

/** Where an effective setting comes from. */
export type SettingSource = "env" | "file" | "nacos" | "db" | "default";

/** The admin console's view of the platform switch: its effective value and its source. */
export interface ExternalSharingView {
  value: "allow" | "deny";
  source: SettingSource;
}

/** The admin console's view of the expiry maximum: its effective value and its source. */
export interface ShareMaxExpiryView {
  value: number;
  source: SettingSource;
}

type ConfigReader = Pick<KernelConfigService, "get" | "fieldSource">;

async function readStored(
  db: KernelSchemaDb,
  key: string,
): Promise<{ value: unknown } | undefined> {
  return db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
}

/**
 * The platform's effective external sharing switch, read live from PG (in the caller's transaction
 * when there is one): the startup config, else the stored choice (invalid: `deny` with a warning),
 * else `deny`.
 */
export async function readExternalSharing(
  db: KernelSchemaDb,
  config: ConfigReader,
  log?: Pick<KernelLogger, "warn">,
): Promise<ExternalSharingView> {
  const configured = config.get().sharing.external;
  const source = config.fieldSource("sharing.external");
  if (configured !== undefined && source !== undefined) return { value: configured, source };
  const row = await readStored(db, EXTERNAL_SHARING_SETTING);
  if (row === undefined) return { value: EXTERNAL_SHARING_DEFAULT, source: "default" };
  const parsed = ExternalSharingValue.safeParse(row.value);
  if (parsed.success) return { value: parsed.data, source: "db" };
  log?.warn("invalid deployment setting; it reads as external sharing denied", {
    key: EXTERNAL_SHARING_SETTING,
  });
  return { value: "deny", source: "db" };
}

/**
 * The platform's effective share expiry maximum in days, read live from PG: the startup config,
 * else the stored choice (invalid: {@link SHARE_MAX_EXPIRY_DEFAULT} with a warning), else the
 * default.
 */
export async function readShareMaxExpiry(
  db: KernelSchemaDb,
  config: ConfigReader,
  log?: Pick<KernelLogger, "warn">,
): Promise<ShareMaxExpiryView> {
  const configured = config.get().sharing.maxExpiryDays;
  const source = config.fieldSource("sharing.maxExpiryDays");
  if (configured !== undefined && source !== undefined) return { value: configured, source };
  const row = await readStored(db, SHARE_MAX_EXPIRY_SETTING);
  if (row === undefined) return { value: SHARE_MAX_EXPIRY_DEFAULT, source: "default" };
  const parsed = ShareMaxExpiryDays.safeParse(row.value);
  if (parsed.success) return { value: parsed.data, source: "db" };
  log?.warn("invalid deployment setting; it reads as the default share expiry maximum", {
    key: SHARE_MAX_EXPIRY_SETTING,
  });
  return { value: SHARE_MAX_EXPIRY_DEFAULT, source: "db" };
}

/**
 * Whether an org may create and open external shares now: `platform_denied` when the platform
 * denies it (whatever the org says), `org_off` when the org has not turned it on (absent = off),
 * else `allowed`.
 */
export type ExternalSharingState = "allowed" | "platform_denied" | "org_off";

export function effectiveExternalSharing(
  platform: "allow" | "deny",
  org: "on" | "off" | undefined,
): ExternalSharingState {
  if (platform !== "allow") return "platform_denied";
  return org === "on" ? "allowed" : "org_off";
}

/** The CDN allowlist when the super admin has not changed it (spec §4). */
export const HTML_CDN_ALLOWLIST_DEFAULT: readonly string[] = Object.freeze([
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
]);

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** `https://` + host (DNS labels or an IPv4 address) + optional port; nothing else. */
const ORIGIN_RE = new RegExp(`^https://(?:${LABEL}\\.)*${LABEL}(?::(\\d{1,5}))?$`);

/**
 * One allowlist entry: an `https://` origin, host with an optional port, lower-cased; no path (not
 * even `/`), query, fragment, user info or wildcard. Lower-casing is an overwrite, so the schema
 * stays representable as JSON Schema (DTOs, the Platform tool).
 */
export const CdnOrigin: z.ZodType<string> = z
  .string()
  .max(300)
  .toLowerCase()
  .regex(ORIGIN_RE, "must be an https:// origin: scheme and host, an optional port, nothing else")
  .refine(
    (s) => {
      const port = ORIGIN_RE.exec(s)?.[1];
      return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
    },
    { message: "the port must be 1 to 65535" },
  );

/** The CDN allowlist: at most 50 origins. */
export const HtmlCdnAllowlistSchema = z.array(CdnOrigin).max(50);

/**
 * The CDN allowlist, read live from PG at every document load: missing -> the default; invalid ->
 * the default with a warning (the same fallback the settings service applies to every key).
 */
export async function readHtmlCdnAllowlist(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<readonly string[]> {
  const row = await readStored(db, HTML_CDN_ALLOWLIST_SETTING);
  if (row === undefined) return HTML_CDN_ALLOWLIST_DEFAULT;
  const parsed = HtmlCdnAllowlistSchema.safeParse(row.value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; using default", { key: HTML_CDN_ALLOWLIST_SETTING });
  return HTML_CDN_ALLOWLIST_DEFAULT;
}
