import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

const Config = z.record(z.string().max(200), z.unknown());
const Policy = z.enum(["bind", "anonymous"]);

export const ChannelCreateSchema = z
  .object({
    plugin: z.string().min(1).max(214),
    name: z.string().trim().min(1).max(100),
    agentId: z.string().min(1).max(100),
    config: Config,
    unboundPolicy: Policy.optional(),
  })
  .strict();

export const ChannelPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    agentId: z.string().min(1).max(100).optional(),
    unboundPolicy: Policy.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    // webhook needs plugin support and channels.webhookBaseUrl (409 channel.webhook_unavailable)
    inboundMode: z.enum(["long_connection", "webhook"]).optional(),
    config: Config.optional(),
  })
  .strict();

/** 「我已更新应用」: the template hash of the setup guide the person was shown. */
export const ChannelGuideAckSchema = z
  .object({ hash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

export const ChannelPathParams = z.object({ connectionId: z.string().min(1).max(100) });

export const CHANNEL_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/channels" },
  { route: "GET /api/v1/orgs/:orgId/channels/:connectionId", params: ChannelPathParams },
  {
    route: "PATCH /api/v1/orgs/:orgId/channels/:connectionId",
    params: ChannelPathParams,
    body: ChannelPatchSchema,
  },
  { route: "DELETE /api/v1/orgs/:orgId/channels/:connectionId", params: ChannelPathParams },
];
