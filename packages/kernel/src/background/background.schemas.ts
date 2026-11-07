import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

export const BackgroundConversationParams = z.object({ id: z.string().min(1).max(100) });
export const BackgroundTaskParams = z.object({
  id: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100),
});

export const BACKGROUND_ROUTES: readonly RouteSchemas[] = [
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/background-tasks",
    params: BackgroundConversationParams,
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/background-tasks/:taskId/stop",
    params: BackgroundTaskParams,
  },
];
