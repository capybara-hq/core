import type { ConnectorSummary } from "../connectors";
import {
  getAdminSetupGuide,
  getDeploymentGuides,
  getSetupGuide,
  type SetupGuideQuery,
  type SetupGuideRef,
} from "../setup-guides";
import { defineQuery } from "./define";
import { keys } from "./keys";

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
      templateId: q.templateId ?? "",
      mode: q.mode ?? "",
      audience: q.audience ?? "",
      locale: q.locale ?? "",
    }),
    fn: () => getSetupGuide(orgId, ref, q).then((r) => r.guide),
    freshness: "orgConfig",
  });

/**
 * A template's setup guide as the super admin sees it (spec §9.3): no org, no target; shown for
 * `templateId` (a guide may cover several templates).
 */
export const adminSetupGuideQuery = (
  ref: SetupGuideRef,
  locale: "en" | "zh",
  templateId?: string,
) =>
  defineQuery({
    key: keys
      .deployment()
      .adminSetupGuide(ref.itemId, ref.guideId, ref.version ?? "", templateId ?? "", locale),
    fn: () =>
      getAdminSetupGuide(ref, { locale, ...(templateId !== undefined && { templateId }) }).then(
        (r) => r.guide,
      ),
    freshness: "deployment",
  });

/** An extension's platform setup guides (super admins, its page): no org, no target. */
export const deploymentGuidesQuery = (plugin: string, locale: "en" | "zh") =>
  defineQuery({
    key: keys.deployment().deploymentGuides(plugin, locale),
    fn: () => getDeploymentGuides(plugin, { locale }).then((r) => r.guides),
    freshness: "deployment",
  });

/**
 * The member text of a connector's template guide for that connector (the 如何连接 sheet, and
 * whether the guide has a member section at all); a connector without a guide reads nothing.
 */
export const memberGuideQuery = (
  orgId: string,
  c: Pick<ConnectorSummary, "id" | "setupGuide">,
  locale: "en" | "zh",
) =>
  setupGuideQuery(orgId, c.setupGuide ?? { itemId: "", guideId: "" }, {
    connectorId: c.id,
    audience: "member",
    locale,
  });
