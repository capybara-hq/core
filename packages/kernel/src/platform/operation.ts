import type { z } from "zod";
import type { OrgAction } from "../orgs/roles.js";

/**
 * How an operation is confirmed (spec §6.2): `read` runs; `personal` asks each time and may be
 * remembered; `org` / `platform` ask each time and are never remembered.
 */
export type ConfirmClass = "read" | "personal" | "org" | "platform";

/** Who may call an operation: the org action of the route it mirrors, or the super admin. */
export type OperationAuthz = { orgAction: OrgAction } | { superAdmin: true };

/** What an operation's handler gets besides its input: the actor and where the call happens. */
export interface OperationContext {
  orgId: string;
  /** The run's trigger account (spec §6.1), the principal the handler acts as. */
  actorAccountId: string;
  agentId: string;
  conversationId: string;
  runId: string | null;
  signal: AbortSignal;
}

/** One operation of the `Platform` tool (spec §7), defined next to its domain. */
export interface PlatformOperation<I = unknown> {
  /** `<domain>.<verb>`, matching {@link OPERATION_ID}; the domain is one of {@link PLATFORM_DOMAINS}. */
  id: string;
  /** English, one paragraph; the first sentence is the line `browse` and `search` show. */
  description: string;
  /** Every string bounded; `describe` shows its JSON Schema. */
  input: z.ZodType<I>;
  example: I;
  /** The route's authorization, or the role the service enforces (spec §9). */
  authz: OperationAuthz;
  /** The HTTP routes it corresponds to, e.g. `POST /api/v1/orgs/:orgId/skills`; [] when synthetic. */
  mirrors: readonly string[];
  confirm: ConfirmClass;
  /**
   * The bilingual card summary of a write, rendered from the input (never from model text);
   * required unless `confirm` is `read`. Method syntax so an operation of any input type is a
   * `PlatformOperation` (the registry's element type).
   */
  summary?(input: I): { zh: string; en: string };
  run(input: I, ctx: OperationContext): Promise<unknown>;
}

/** Identity helper that types an operation's handler and summary from its input schema. */
export function defineOperation<I>(op: PlatformOperation<I>): PlatformOperation<I> {
  return op;
}

/** The shape of an operation id: `<domain>.<verb>`, lower case words joined by `-`. */
export const OPERATION_ID = /^[a-z][a-z-]*\.[a-z][a-z-]*$/;

/** The domain part of an operation id (`skills` of `skills.list`). */
export const operationDomain = (id: string): string => id.slice(0, id.indexOf("."));

/** The phase 1 domains (spec §7), in the order `browse` lists them; model-visible English. */
export const PLATFORM_DOMAINS: readonly { id: string; description: string }[] = [
  {
    id: "platform",
    description: "What this platform is, its tool families, and what you and this agent can do.",
  },
  { id: "skills", description: "The org's skill library: list, read, create, switch on or off." },
  { id: "agents", description: "Agents in the org: list, read, create, update your own." },
  {
    id: "agent-templates",
    description: "Agent templates: list, read, save an agent as a template.",
  },
  {
    id: "plugins",
    description: "Plugins in the org and on the platform: list, read, enable, disable, update.",
  },
  {
    id: "marketplaces",
    description: "Marketplace sources and their entries: list, browse, add, request a plugin.",
  },
  { id: "requests", description: "Requests to admins: list yours, create one." },
  { id: "connectors", description: "Connectors and connector templates: list and read." },
  { id: "extensions", description: "Extensions in the org (state only) and extension points." },
];

/**
 * Something that contributes operations (a domain's provider). Kept as a type only: providers
 * call `PlatformOperations.register` from their `onModuleInit` (ruling P2), so `PlatformModule`
 * imports no domain module.
 */
export interface OperationProvider {
  operations(): readonly PlatformOperation[];
}
