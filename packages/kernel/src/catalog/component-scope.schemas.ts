import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { COMPONENT_KINDS, type ComponentKind } from "./component-state.js";

export const ComponentKindSchema = z.enum(COMPONENT_KINDS as [ComponentKind, ...ComponentKind[]]);

export const OrgComponentListQuery = z
  .object({ kind: ComponentKindSchema.optional(), itemId: z.string().uuid().optional() })
  .strict();

export const COMPONENT_SCOPE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/components", query: OrgComponentListQuery },
];
