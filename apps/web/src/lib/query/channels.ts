import { getChannel, getChannelSchema, listChannels } from "../channels";
import { getOrgOverrides, listOrgExtensions, listOrgToolSwitches } from "../extensions";
import {
  getAdminSetupGuide,
  getSetupGuide,
  type SetupGuideQuery,
  type SetupGuideRef,
} from "../setup-guides";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's channel connections (`{ channels }`, as the kernel answers). */
export const channelsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).channels(),
    fn: () => listChannels(orgId),
    freshness: "orgConfig",
  });

/** One channel connection (a 404 is the page's not-found). */
export const channelQuery = (orgId: string, channelId: string) =>
  defineQuery({
    key: keys.org(orgId).channel(channelId),
    fn: () => getChannel(orgId, channelId).then((r) => r.channel),
    freshness: "orgConfig",
  });

/** A channel plugin's connection schema (refused while the plugin is uninstalled or disabled). */
export const channelSchemaQuery = (orgId: string, plugin: string) =>
  defineQuery({
    key: keys.org(orgId).channelSchema(plugin),
    fn: () => getChannelSchema(orgId, plugin).then((r) => r.schema),
    freshness: "orgConfig",
  });

/**
 * Where a channel plugin's setup guide is (null without one): 新建渠道 shows it once the plugin is
 * picked. The schema route answers it beside the schema.
 */
export const channelGuideRefQuery = (orgId: string, plugin: string) =>
  defineQuery({
    key: keys.org(orgId).channelGuideRef(plugin),
    fn: () => getChannelSchema(orgId, plugin).then((r) => r.guide ?? null),
    freshness: "orgConfig",
  });

/**
 * A plugin's setup guide rendered for the org: a target (a connection, the name typed so far, a
 * connector), a mode, an audience and the language.
 */
export const setupGuideQuery = (orgId: string, ref: SetupGuideRef, q: SetupGuideQuery = {}) =>
  defineQuery({
    key: keys.org(orgId).setupGuide(ref.itemId, ref.guideId, ref.version ?? "", {
      connectionId: q.connectionId ?? "",
      name: q.name ?? "",
      connectorId: q.connectorId ?? "",
      mode: q.mode ?? "",
      audience: q.audience ?? "",
      locale: q.locale ?? "",
    }),
    fn: () => getSetupGuide(orgId, ref, q).then((r) => r.guide),
    freshness: "orgConfig",
  });

/** A template's setup guide as the super admin sees it (spec §9.3): no org, no target. */
export const adminSetupGuideQuery = (ref: SetupGuideRef, locale: "en" | "zh") =>
  defineQuery({
    key: keys.deployment().adminSetupGuide(ref.itemId, ref.guideId, ref.version ?? "", locale),
    fn: () => getAdminSetupGuide(ref, { locale }).then((r) => r.guide),
    freshness: "deployment",
  });

/** The org's extensions (`{ extensions }`): which channel plugins it can connect. */
export const orgExtensionsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).orgExtensions(),
    fn: () => listOrgExtensions(orgId),
    freshness: "orgConfig",
  });

/** One extension's two-level config in the org (org admins; read by the extension's Sheet). */
export const orgExtensionOverridesQuery = (orgId: string, plugin: string) =>
  defineQuery({
    key: keys.org(orgId).orgExtensionOverrides(plugin),
    fn: () => getOrgOverrides(orgId, plugin),
    freshness: "orgConfig",
  });

/** One extension's single-tool switches in the org (members read; the extension's Sheet). */
export const orgToolSwitchesQuery = (orgId: string, plugin: string) =>
  defineQuery({
    key: keys.org(orgId).extensionToolSwitches(plugin),
    fn: () => listOrgToolSwitches(orgId, plugin),
    freshness: "orgConfig",
  });
