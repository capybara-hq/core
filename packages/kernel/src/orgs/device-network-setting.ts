import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { DeviceNetworkMode } from "../sandbox/device-sandbox.js";

/** The org device network allowlist's host limit. */
export const ORG_SANDBOX_ALLOW_HOSTS_MAX = 200;

/** One host list of the org's device network: at most {@link ORG_SANDBOX_ALLOW_HOSTS_MAX} valid, unique hosts. */
const orgHostList = (name: string) =>
  z
    .array(z.string())
    .max(ORG_SANDBOX_ALLOW_HOSTS_MAX)
    .superRefine((hosts, ctx) => {
      hosts.forEach((h, i) => {
        for (const message of validateAllowHost(h)) {
          ctx.addIssue({ code: "custom", path: [i], message: `${h}: ${message}` });
        }
      });
      if (new Set(hosts).size !== hosts.length) {
        ctx.addIssue({ code: "custom", message: `${name} must not contain duplicates` });
      }
    })
    .optional();

const Mode = z.enum(["open", "allowlist"]) satisfies z.ZodType<DeviceNetworkMode>;

/**
 * The org's device sandbox network (approval-only profiles design, "Settings model"), for local and
 * cloud devices alike, with its hosts stored as a delta over the platform's
 * `sandbox.limits.allowHosts`, never a copy of it, so platform changes keep reaching the org:
 * - `default`: the network a device of the org gets when its owner chooses none (`open` or
 *   `allowlist`); absent follows the platform's `devices.network.default`.
 * - `ceiling`: the widest network a device of the org may choose; absent follows the platform's
 *   `devices.network.ceiling`. Never above the platform's ceiling (`org.network_not_allowed`); a
 *   default above the ceiling is refused.
 * - `base`: `platform` (the default: start from the platform's list) or `none` (only the org's own
 *   hosts).
 * - `extraHosts`: hosts the org adds (ignored outside the platform list under `orgHosts: within`).
 * - `excludedHosts`: platform entries the org drops (exact entries; any host is accepted, since the
 *   platform may drop an entry later).
 * The effective hosts are `orgEffectiveHosts` in `sandbox/modes.ts`.
 */
export const DeviceNetworkSettingSchema = z
  .object({
    default: Mode.optional(),
    ceiling: Mode.optional(),
    base: z.enum(["platform", "none"]).optional(),
    extraHosts: orgHostList("extraHosts"),
    excludedHosts: orgHostList("excludedHosts"),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.default === "open" && n.ceiling === "allowlist")
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message:
          "default open is above ceiling allowlist; choose a default no wider than the ceiling",
      });
  });

export type DeviceNetworkSetting = z.infer<typeof DeviceNetworkSettingSchema>;

/** What an invalid stored `deviceNetwork` reads as: the allowlist with no host (never wider). */
export const invalidDeviceNetwork = (): DeviceNetworkSetting => ({
  default: "allowlist",
  ceiling: "allowlist",
  base: "none",
});

/**
 * The org network shape before the approval-only profiles design (`cloudNetwork`), read only to
 * convert it ({@link convertLegacyCloudNetwork}) and to keep it in step for replicas of the
 * previous version until the permission configuration publication converts it.
 */
export const LegacyCloudNetworkSchema = z
  .object({
    mode: Mode.optional(),
    base: z.enum(["platform", "none"]).optional(),
    extraHosts: orgHostList("extraHosts"),
    excludedHosts: orgHostList("excludedHosts"),
  })
  .strict();

export type LegacyCloudNetwork = z.infer<typeof LegacyCloudNetworkSchema>;

/** Drops absent fields; an object with none left is `undefined` (follow the platform). */
function compact(n: DeviceNetworkSetting): DeviceNetworkSetting | undefined {
  const out = Object.fromEntries(
    Object.entries(n).filter(([, v]) => v !== undefined),
  ) as DeviceNetworkSetting;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * The stored-key conversion of an org's old `cloudNetwork` (design, "Migration"): `mode:
 * "allowlist"` becomes `ceiling: "allowlist"`, keeping `base`, `extraHosts` and `excludedHosts`;
 * `mode: "open"` or absent becomes absent. An invalid old value converts to
 * {@link invalidDeviceNetwork}, as it read before (never wider). `undefined` stays `undefined`.
 */
export function convertLegacyCloudNetwork(raw: unknown): DeviceNetworkSetting | undefined {
  if (raw === undefined) return undefined;
  const parsed = LegacyCloudNetworkSchema.safeParse(raw);
  if (!parsed.success) return invalidDeviceNetwork();
  const { mode, ...hosts } = parsed.data;
  return compact({ ...(mode === "allowlist" && { ceiling: "allowlist" }), ...hosts });
}

/**
 * The old `cloudNetwork` that says no more than `n`, written next to `deviceNetwork` while the old
 * key is still stored (replicas of the previous version read it): `mode: "allowlist"` when either
 * the default or the ceiling is the allowlist (never wider for an old reader). `undefined` when `n`
 * says nothing the old shape holds.
 */
export function legacyCloudNetworkOf(
  n: DeviceNetworkSetting | undefined,
): LegacyCloudNetwork | undefined {
  if (n === undefined) return undefined;
  const { default: def, ceiling, ...hosts } = n;
  const out = {
    ...((def === "allowlist" || ceiling === "allowlist") && { mode: "allowlist" as const }),
    ...hosts,
  };
  return Object.keys(out).length === 0 ? undefined : (out as LegacyCloudNetwork);
}

/**
 * `n` with the ceiling (and an open default) narrowed to the allowlist: what an old `fullAccess:
 * "off"` adds, since it kept every device of the org on the allowlist (never wider).
 */
export const withAllowlistCeiling = (
  n: DeviceNetworkSetting | undefined,
): DeviceNetworkSetting => ({
  ...n,
  ...(n?.default !== undefined && { default: "allowlist" as const }),
  ceiling: "allowlist",
});

const narrowerMode = (a: DeviceNetworkMode | undefined, b: DeviceNetworkMode | undefined) =>
  a === "allowlist" || b === "allowlist" ? ("allowlist" as const) : (a ?? b);

/**
 * A delta never wider than either `a` or `b` (absent: follow the platform), for two stored values
 * that disagree (fail closed): the narrower default and ceiling, base `none` when either is, only
 * the extra hosts both hold (each covering the other's exactly), and every exclusion of either.
 * It may be narrower than both; it is only read while an old replica's write diverges.
 */
export function narrowerDeviceNetwork(
  a: DeviceNetworkSetting | undefined,
  b: DeviceNetworkSetting | undefined,
): DeviceNetworkSetting | undefined {
  if (a === undefined && b === undefined) return undefined;
  const ceiling = narrowerMode(a?.ceiling, b?.ceiling);
  let def = narrowerMode(a?.default, b?.default);
  if (ceiling === "allowlist" && def === "open") def = "allowlist";
  const extraA = new Set(a?.extraHosts ?? []);
  const extra = (b?.extraHosts ?? []).filter((h) => extraA.has(h));
  const excluded = [...new Set([...(a?.excludedHosts ?? []), ...(b?.excludedHosts ?? [])])];
  return compact({
    default: def,
    ceiling,
    base: a?.base === "none" || b?.base === "none" ? "none" : (a?.base ?? b?.base),
    extraHosts: extra.length > 0 ? extra : undefined,
    excludedHosts: excluded.length > 0 ? excluded : undefined,
  });
}
