import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
/** The org cloud-network allowlist's host limit. */
export const ORG_SANDBOX_ALLOW_HOSTS_MAX = 200;

/** One host list of the org's cloud network: at most {@link ORG_SANDBOX_ALLOW_HOSTS_MAX} valid, unique hosts. */
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

/**
 * The org's sandbox-mode network (org egress ceiling spec §D1), stored as a delta over the
 * platform's `sandbox.limits.allowHosts`, never a copy of it, so platform changes keep reaching the
 * org:
 * - `mode`: the cloud network of a cloud device in sandbox mode, `open` (any public host; loopback,
 *   private and cloud metadata addresses are blocked outside the container) or `allowlist`; absent
 *   follows the platform's default (open). `sandbox.limits.orgHosts: within` makes it the allowlist.
 * - `base`: `platform` (the default: start from the platform's list) or `none` (only the org's own
 *   hosts).
 * - `extraHosts`: hosts the org adds (ignored outside the platform list under `within`).
 * - `excludedHosts`: platform entries the org drops (exact entries; any host is accepted, since the
 *   platform may drop an entry later).
 * The effective hosts ({@link orgEffectiveHosts} in `sandbox/modes.ts`) are also the ceiling a local
 * device in sandbox mode reaches (the device intersects them with its own list).
 */
export const CloudNetworkSettingSchema = z
  .object({
    mode: z.enum(["open", "allowlist"]).optional(),
    base: z.enum(["platform", "none"]).optional(),
    extraHosts: orgHostList("extraHosts"),
    excludedHosts: orgHostList("excludedHosts"),
  })
  .strict();

export type CloudNetworkSetting = z.infer<typeof CloudNetworkSettingSchema>;

/** What an invalid stored `cloudNetwork` reads as: the allowlist with no host (never wider). */
export const invalidCloudNetwork = (): CloudNetworkSetting => ({
  mode: "allowlist",
  base: "none",
});
