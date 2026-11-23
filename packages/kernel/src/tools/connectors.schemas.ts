import {
  CONNECTOR_TEMPLATE_LIMITS,
  ConnectorAuthSchema,
  GitSourceSchema,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/**
 * A credential value: `Credentials.validate` checks its shape by auth method (values are never
 * echoed); this only bounds its size. A secret (`secret()` meta, ruling R2): a Platform operation
 * never takes it as a param; the person enters it in a secure input request.
 */
export const CredentialValue = secret(
  z
    .record(z.string().max(100), z.unknown())
    .refine((v) => JSON.stringify(v).length <= 16_384, { message: "Credential is too large" }),
);

/** 「我已更新应用」: the admin drift hash of the connector template guide the person was shown. */
export const ConnectorGuideAckSchema = z
  .object({ hash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

/** `:connectorId` as the routes take it (`@Param`). */
export const ConnectorPathParams = z.object({ connectorId: z.string().min(1) });

/**
 * `PUT …/connectors/:connectorId/git-push-policy`: the org's default for pushes through the
 * connector's credential in sandboxes (the virtual tool `git_push`, sandbox git credentials
 * spec §7).
 */
export const GitPushPolicyBody = z.object({ policy: z.enum(["allow", "ask", "deny"]) }).strict();

/** `POST …/connectors`: a custom connector with its endpoint, auth method and credential. */
/** Upper bound on a connector's own description, in characters (as a template's, per text). */
export const CONNECTOR_DESCRIPTION_MAX = CONNECTOR_TEMPLATE_LIMITS.descriptionChars;

/** A connector's own description: plain text an org admin typed, trimmed (blank means none). */
const ConnectorDescription = z
  .string()
  .trim()
  .max(CONNECTOR_DESCRIPTION_MAX)
  .describe("The connector's own description, plain text shown on the connector pages.");

export const ConnectorCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().max(24).optional(),
    connector: z.string().min(1).max(100),
    endpoint: z.record(z.string(), z.unknown()),
    auth: ConnectorAuthSchema,
    credential: CredentialValue.optional(),
    /** The git hosts the credential serves in sandboxes (sandbox git credentials spec §6.1). */
    git: GitSourceSchema.optional(),
    /** The connector's own description (plain text; blank: none). */
    description: ConnectorDescription.optional(),
  })
  .strict();

/**
 * `POST …/connectors/preview` (ruling A20): the create's connector, endpoint, auth and credential;
 * the auth may be left out (reads the endpoint description only, lists no tools).
 */
export const ConnectorPreviewSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().max(24).optional(),
    connector: z.string().min(1).max(100),
    endpoint: z.record(z.string(), z.unknown()),
    auth: ConnectorAuthSchema.optional(),
    credential: CredentialValue.optional(),
  })
  .strict();

const ToolPatch = z
  .object({
    status: z.enum(["enabled", "disabled"]).optional(),
    defaultPolicy: z.enum(["allow", "ask", "deny"]).optional(),
  })
  .strict();

/**
 * `PATCH …/connectors/:connectorId`: rename, switch on or off, per-tool state and default policy,
 * every unannotated tool to allow, and git use. No endpoint and no credential.
 */
export const ConnectorUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    tools: z
      .record(z.string().max(200), ToolPatch)
      .refine((v) => Object.keys(v).length <= 1000, { message: "Too many tools" })
      .optional(),
    allowUnannotated: z.boolean().optional(),
    /** Use an org-credential connector for git in sandboxes (spec 2026-11-12 §6.2). */
    useForGit: z.boolean().optional(),
    /** The connector's own description; null or blank removes it. */
    description: ConnectorDescription.nullable().optional(),
  })
  .strict();

export const CONNECTOR_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/connectors" },
  { route: "GET /api/v1/orgs/:orgId/connectors/kinds" },
  { route: "POST /api/v1/orgs/:orgId/connectors", body: ConnectorCreateSchema },
  { route: "POST /api/v1/orgs/:orgId/connectors/preview", body: ConnectorPreviewSchema },
  {
    route: "PATCH /api/v1/orgs/:orgId/connectors/:connectorId",
    params: ConnectorPathParams,
    body: ConnectorUpdateSchema,
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack",
    params: ConnectorPathParams,
    body: ConnectorGuideAckSchema,
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/org",
    params: ConnectorPathParams,
    body: CredentialValue,
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me",
    params: ConnectorPathParams,
    body: CredentialValue,
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me",
    params: ConnectorPathParams,
  },
  { route: "GET /api/v1/orgs/:orgId/connectors/:connectorId", params: ConnectorPathParams },
  { route: "DELETE /api/v1/orgs/:orgId/connectors/:connectorId", params: ConnectorPathParams },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/refresh",
    params: ConnectorPathParams,
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/git-push-policy",
    params: ConnectorPathParams,
    body: GitPushPolicyBody,
  },
];

/**
 * `PUT …/connectors/:connectorId/tool-policies/me`: the caller's own policy per tool name (null
 * clears it; decision 2026-11-09). A key may also be a standing push decision
 * `git_push:<host>/<owner>/<repo>` (only cleared), hence the longer bound.
 */
export const MemberToolPoliciesBody = z
  .object({
    tools: z
      .record(z.string().min(1).max(500), z.enum(["allow", "ask", "deny"]).nullable())
      .refine((v) => Object.keys(v).length <= 1000, { message: "Too many tools" }),
  })
  .strict();
