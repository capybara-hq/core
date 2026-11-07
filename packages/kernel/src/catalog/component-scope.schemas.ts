import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { COMPONENT_KINDS, type ComponentKind } from "./component-state.js";

export const ComponentKindSchema = z.enum(COMPONENT_KINDS as [ComponentKind, ...ComponentKind[]]);

export const OrgComponentListQuery = z
  .object({ kind: ComponentKindSchema.optional(), itemId: z.string().uuid().optional() })
  .strict();

/** `?kind=` of the admin component list. */
export const ComponentListQuery = z.object({ kind: ComponentKindSchema }).strict();
export const ComponentParams = z.object({
  kind: ComponentKindSchema,
  id: z.string().min(1).max(128),
});

/** `{ enabled, confirm? }` of the org's switch of a platform component. */
export const ComponentSwitchBody = z
  .object({
    enabled: z.boolean(),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const COMPONENT_SCOPE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/components", query: OrgComponentListQuery },
  { route: "GET /api/v1/admin/components", query: ComponentListQuery },
  { route: "GET /api/v1/admin/components/:kind/:id/versions", params: ComponentParams },
  {
    route: "PUT /api/v1/orgs/:orgId/components/:kind/:id/switch",
    params: ComponentParams,
    body: ComponentSwitchBody,
  },
];
