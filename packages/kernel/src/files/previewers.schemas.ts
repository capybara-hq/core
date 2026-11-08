import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

const Id = z.string().min(1).max(100);

export const FilePreviewersOrderBody = z.object({
  items: z.array(z.object({ plugin: Id, id: Id, disabled: z.boolean().default(false) })).max(500),
});

export const FILE_PREVIEWER_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/file-previewers" },
  { route: "PUT /api/v1/orgs/:orgId/file-previewers", body: FilePreviewersOrderBody },
];
