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

const Scope = z.enum(["all", "optional", "named"]);
const Orgs = z.array(z.string().min(1).max(128)).max(1000);
const Hash = z.string().min(1).max(128);

const exactlyOnePreviewTarget = (b: { scope?: unknown; disabled?: true | undefined; follow?: true | undefined }) =>
  [b.scope !== undefined, b.disabled === true, b.follow === true].filter(Boolean).length === 1;
const orgsNeedScope = (b: { scope?: unknown; orgs?: unknown }) =>
  b.scope !== undefined || b.orgs === undefined;
const scopeXorFollow = (b: { scope?: unknown; follow?: true | undefined }) =>
  (b.scope !== undefined) !== (b.follow === true);

/** The fields of the scope preview body, before its refinements (zod 4 cannot `extend` a refined object). */
export const ComponentScopePreviewFields = z
  .object({
    scope: Scope.optional(),
    orgs: Orgs.optional(),
    disabled: z.literal(true).optional(),
    follow: z.literal(true).optional(),
  })
  .strict();
/** `{ scope, orgs? }`, `{ disabled: true }` or `{ follow: true }`: exactly one. */
export const ComponentScopePreviewSchema = ComponentScopePreviewFields.refine(
  exactlyOnePreviewTarget,
  { message: "send exactly one of scope (with orgs for named), disabled: true or follow: true" },
).refine(orgsNeedScope, { message: "orgs: only allowed with scope named", path: ["orgs"] });

/** The fields of the scope body, before its refinements. */
export const ComponentScopeFields = z
  .object({
    scope: Scope.optional(),
    orgs: Orgs.optional(),
    follow: z.literal(true).optional(),
    scopeHash: Hash,
  })
  .strict();
/** `{ scope, orgs?, scopeHash }` or `{ follow: true, scopeHash }`. */
export const ComponentScopeSchema = ComponentScopeFields.refine(scopeXorFollow, {
  message: "send either scope (with orgs for named) or follow: true",
}).refine(orgsNeedScope, { message: "orgs: only allowed with scope named", path: ["orgs"] });

export const ComponentDisabledSchema = z
  .object({ disabled: z.boolean(), scopeHash: Hash.optional() })
  .strict();
export const ComponentShownSchema = z.object({ shownToOthers: z.boolean() }).strict();
export const ComponentIdSchema = z.object({ id: z.string().min(1).max(128) });
export const ComponentTemplateVersionSchema = z
  .object({ content: z.string().min(1).max(400_000) })
  .strict();

/** The refinements of the two scope bodies, for operations that rebuild them from the fields. */
export const componentScopeRules = { exactlyOnePreviewTarget, orgsNeedScope, scopeXorFollow };

export const COMPONENT_SCOPE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/components", query: OrgComponentListQuery },
  { route: "GET /api/v1/admin/components", query: ComponentListQuery },
  { route: "GET /api/v1/admin/components/:kind/:id/versions", params: ComponentParams },
  {
    route: "POST /api/v1/admin/components/:kind/:id/scope/preview",
    params: ComponentParams,
    body: ComponentScopePreviewSchema,
  },
  {
    route: "PUT /api/v1/admin/components/:kind/:id/scope",
    params: ComponentParams,
    body: ComponentScopeSchema,
  },
  {
    route: "PUT /api/v1/admin/components/:kind/:id/disabled",
    params: ComponentParams,
    body: ComponentDisabledSchema,
  },
  {
    route: "PUT /api/v1/admin/components/:kind/:id/shown",
    params: ComponentParams,
    body: ComponentShownSchema,
  },
  {
    route: "POST /api/v1/admin/components/agent_template/:id/versions",
    params: ComponentIdSchema,
    body: ComponentTemplateVersionSchema,
  },
  {
    route: "PUT /api/v1/orgs/:orgId/components/:kind/:id/switch",
    params: ComponentParams,
    body: ComponentSwitchBody,
  },
];
