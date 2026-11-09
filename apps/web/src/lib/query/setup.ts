import type { ConnectorSummary } from "../connectors";
import {
  getAdminSetupGuide,
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
