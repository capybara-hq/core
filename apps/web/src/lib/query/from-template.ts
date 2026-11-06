import { previewFromTemplate } from "../from-template";
import { getPendingConnectorsRequest } from "../pending-connectors";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * What creating an agent from the template carries over (rulings P4-5, P4-18), read when the
 * 用它创建 dialog opens: live, so a later opening reads it again (a stale one is a 409 anyway).
 */
export const templatePreviewQuery = (orgId: string, templateId: string) =>
  defineQuery({
    key: keys.org(orgId).templatePreview(templateId),
    fn: () => previewFromTemplate(orgId, templateId),
    freshness: "live",
  });

/** The agent's latest connector setup request (`{ request }`, owner or org admin; ruling P4-7). */
export const setupRequestQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).setupRequest(agentId),
    fn: () => getPendingConnectorsRequest(orgId, agentId),
    freshness: "live",
  });
