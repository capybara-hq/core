import type { z } from "zod";
import type { OrgAction } from "../orgs/roles.js";
import type { ErrorRole } from "./errors.js";

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
  /**
   * The tool call being run (absent at confirmation time): what a result shown only on the web is
   * keyed by, e.g. the generated password of `accounts.create`, read by the person who approved
   * that call.
   */
  callId?: string;
  signal: AbortSignal;
  /**
   * The actor's role for next steps, from the facts the tool read for this call (spec §14.5
   * item 7). Absent where no tool call is behind the context (a test running `op.run`): read it
   * then with `roleFor` in ./ops/unavailable.ts.
   */
  errorRole?: ErrorRole;
}

/**
 * The next step after an error: one text, or one per role where the step differs (spec §14.5
 * item 7). Only the super admin gets the `superAdmin` text (the admin console path); see
 * `nextStepFor` in ./errors.ts for the fallbacks.
 */
export type OperationErrorNext =
  | string
  | { readonly superAdmin?: string; readonly orgAdmin?: string; readonly member?: string };

/** A notable error code of an operation and what to do next (model-visible English). */
export interface OperationError {
  code: string;
  next: OperationErrorNext;
}

/**
 * What {@link PlatformOperation.precheck} found: nothing known against the write, or why it fails.
 * `next` replaces the operation's `errors[]` entry for the code when the step depends on the target
 * (e.g. the admin console path naming the extension).
 *
 * Some codes exist only in the tool, never answered by a route: `marketplace.already_added` (the
 * `marketplaces.add` duplicate check is tool policy; the web accepts a duplicate source),
 * `plugin.needs_input` (input only a person enters on the web), `agent.visibility_web_only`,
 * `catalog.org_owned` (`plugins.set-shown` leaves an org's own plugin to that org), and
 * `account.self` / `account.no_change` (disabling your own account, a status that is set already).
 */
export type PrecheckResult =
  | { ok: true }
  | { ok: false; code: string; message: string; next?: OperationErrorNext };

/** How long a precheck may take before the tool skips it (spec §14.2 item 2). */
export const PRECHECK_TIMEOUT_MS = 2000;

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
  /**
   * `"service-enforced"`: the service enforces a higher role than the mirrored route's decorator,
   * so `authz` may name a stricter action (`check:platform-ops` requires its role to be at least
   * the route's).
   */
  authzNote?: "service-enforced";
  /** The HTTP routes it corresponds to, e.g. `POST /api/v1/orgs/:orgId/skills`; [] when synthetic. */
  mirrors: readonly string[];
  /**
   * Fields of the mirrored route (body, query, path params but `:orgId`) the input leaves out, e.g.
   * `uploadId` of `skills.create` (spec §14.5 item 3; the parity test in `tools/checks` holds it).
   */
  omits?: readonly string[];
  /** Input fields the mirrored route lacks, e.g. `cursor` of a paged list. */
  extras?: readonly string[];
  /**
   * Input fields compared with a route field of another name or path: `{ skillId: "id" }`, a
   * flattened `{ name: "definition.name" }`. The route field counts as present.
   */
  renames?: Readonly<Record<string, string>>;
  /**
   * Input fields allowed to accept more than the route (bounds, pattern, required-ness, never the
   * type), each with its reason, e.g. a confirm value that also takes `nothing-installed`.
   */
  loosens?: Readonly<Record<string, string>>;
  confirm: ConfirmClass;
  /**
   * `false`: a confirmation is never remembered, whatever the class (a destructive personal write
   * such as deleting a conversation). Static; absent: remembered only for the class `personal`.
   */
  rememberable?: false;
  /**
   * The class of one call when it depends on the target (read at confirmation time): e.g.
   * `agents.update` is `personal` only on a private agent the actor owns and `org` otherwise, so a
   * remembered grant never carries over to a shared agent. Only for writes, never returns `read`;
   * absent: `confirm`. The tool treats a throw as not remembered.
   */
  confirmFor?(input: I, ctx: OperationContext): Promise<ConfirmClass>;
  /**
   * The notable error codes of the operation and what to do next (model-visible English), shown
   * by `describe` (spec §3) and appended to an `ApiError` of that code (spec §14.5 item 7). `next`
   * is keyed by role where the step differs (`check:platform-ops` rule `platform-op-errors`).
   */
  errors?: readonly OperationError[];
  /**
   * Preconditions read before the card (spec §14.2 item 2): a write known to fail (a taken name, a
   * stale preview) is denied with this reason and the person is never asked. Reads only; runs
   * again when an approved call resumes (a failure then returns the error, nothing runs). Bounded
   * by the tool ({@link PRECHECK_TIMEOUT_MS}); a timeout or a throw skips it, and the write's own
   * errors speak.
   */
  precheck?(input: I, ctx: OperationContext): Promise<PrecheckResult>;
  /**
   * The bilingual card summary of a write, rendered from the input and kernel reads (names of
   * the targets, preview counts), never from model text; required unless `confirm` is `read`.
   * May read PG; the tool falls back to the operation id when it throws. Method syntax so an
   * operation of any input type is a `PlatformOperation` (the registry's element type).
   */
  summary?(
    input: I,
    ctx: OperationContext,
  ): { zh: string; en: string } | Promise<{ zh: string; en: string }>;
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
    description:
      "What this platform is, its tool families, what you and this agent can do, and your own preferences (time zone, theme).",
  },
  { id: "skills", description: "The org's skill library: list, read, create, switch on or off." },
  {
    id: "agents",
    description:
      "Agents in the org: list, read, create private ones, update or delete those you may edit, their profile (avatar, quick actions), versions, pending connectors, readiness.",
  },
  {
    id: "agent-templates",
    description:
      "Agent templates: list, read, save an agent as a template, update, share or delete the org's own.",
  },
  {
    id: "plugins",
    description:
      "Plugins in the org and on the platform: list, read, enable, disable, update, scope, import, the org's own uploads.",
  },
  {
    id: "marketplaces",
    description:
      "Marketplace sources and their entries: list, browse, add, edit, refresh, remove, import, request a plugin.",
  },
  {
    id: "requests",
    description:
      "Requests to admins: list yours, create one; org admins list the members' pending ones; the super admin lists the platform's.",
  },
  {
    id: "connectors",
    description: "Connectors and connector templates: list and read, refresh tools, delete.",
  },
  {
    id: "extensions",
    description:
      "Extensions in the org (state, tool switches, extension point defaults, file previewers) and, for the super admin, on the platform (state, pending permission confirmations, enable, disable, uninstall).",
  },
  {
    id: "conversations",
    description:
      "Your own conversations: list, read, rename, archive, delete, read their events, list and stop their background tasks.",
  },
  {
    id: "orgs",
    description:
      "This org (read, rename, members) and, for the super admin, every org and its limits.",
  },
  {
    id: "accounts",
    description: "Platform accounts (super admin): list, read, create, disable, enable.",
  },
  {
    id: "admin",
    description: "The admin console (super admin): dashboard totals and deployment settings.",
  },
  {
    id: "models",
    description:
      "The org's model per purpose, the models available and the ones it switched off; for the super admin, the platform's models: catalog and disabled list, prices, default model per purpose.",
  },
  {
    id: "evals",
    description:
      "Eval sets, their cases and runs, results and labels (org admins): replay a candidate model or prompt over real cases.",
  },
  {
    id: "inbox",
    description:
      "Your inbox (what waits for you, as summaries; dismiss notices) and, for the super admin, the platform inbox. Deciding is done on the web.",
  },
  {
    id: "approvals",
    description:
      "Tool call approvals you can decide: list and read them as summaries, never the call's input. Deciding is done on the web.",
  },
  {
    id: "channels",
    description:
      "The org's channel connections (IM bots): list, read without credentials, change the binding, remove.",
  },
  {
    id: "org-settings",
    description:
      "The org's settings (tool search, language, sandbox policy, the Platform tool switch, the default theme): read and change.",
  },
  {
    id: "devices",
    description:
      "Your own cloud devices (the workspaces your conversations run in): list, read, create, rename, delete, wipe the files.",
  },
  {
    id: "themes",
    description:
      "The themes on in this org, the one in effect for you and the org's theme setting: list. Themes are set through your preferences, the org settings and the deployment settings.",
  },
  {
    id: "ui",
    description:
      "The UI slots an extension can contribute to (the catalog): list. A slot id is a ui contribution's `slot` in a plugin manifest.",
  },
];

/**
 * Something that contributes operations (a domain's provider). Kept as a type only: providers
 * call `PlatformOperations.register` from their `onModuleInit` (ruling P2), so `PlatformModule`
 * imports no domain module.
 */
export interface OperationProvider {
  operations(): readonly PlatformOperation[];
}
