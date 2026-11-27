import { z } from "zod";
import type { ModelRef } from "../agents/definition.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { IanaTimeZone } from "../time-zone.js";
import type { CreateTaskInput, GrantInput, UpdateTaskInput } from "./automations.service.js";

/** Longest task name and prompt, in characters (the same bounds as the service). */
export const AUTOMATION_NAME_MAX = 200;
export const AUTOMATION_PROMPT_MAX = 20_000;

const Id = z.string().min(1).max(100);

/**
 * When a task fires, before the zone is fixed: a 5-field cron, or a local date-time
 * (`2026-12-01T09:00`, no offset) for a one-off run.
 */
export const AutomationTriggerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("once"), at: z.string().trim().min(1).max(40) }).strict(),
]);

/** The IM chat a `chat`-mode task posts into. */
export const AutomationChatInput = z
  .object({
    connectionId: Id,
    chatId: z.string().min(1).max(500),
    chatType: z.enum(["dm", "group"]),
  })
  .strict();

/**
 * A model pick: the same `{ provider, model }` an agent's definition uses, its strings bounded on
 * the fields (so the JSON schema shows the bounds). `new` mode only.
 */
export const AutomationModel = z
  .object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) })
  .strict() satisfies z.ZodType<ModelRef>;

export const AutomationEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** An end time as an ISO 8601 timestamp with an offset (`2026-12-31T00:00:00Z`). */
const ExpiresAt = z.string().datetime({ offset: true });

/**
 * A tool the creator pre-approves for the task, or a domain as `network:<host>` (network
 * ask-to-allow spec §8.1: one exact host; a host name is at most 253 characters).
 */
export const AutomationGrantInput = z
  .object({ toolKey: z.string().trim().min(1).max(270), connectorId: Id.optional() })
  .strict();

const Name = z.string().trim().min(1).max(AUTOMATION_NAME_MAX);
const Prompt = z.string().trim().min(1).max(AUTOMATION_PROMPT_MAX);
const Mode = z.enum(["new", "conversation", "chat"]);

export const AutomationCreateBody = z
  .object({
    agentId: Id,
    name: Name,
    prompt: Prompt,
    trigger: AutomationTriggerInput,
    /** The browser's zone: used only when the account has no zone of its own. */
    timeZone: IanaTimeZone.optional(),
    mode: Mode,
    conversationId: Id.optional(),
    chat: AutomationChatInput.optional(),
    /** `new` mode only, as `effort` and `deviceId` (a conversation or chat task uses its own). */
    model: AutomationModel.optional(),
    effort: AutomationEffort.optional(),
    deviceId: Id.optional(),
    expiresAt: ExpiresAt.nullable().optional(),
    grants: z.array(AutomationGrantInput).max(50).optional(),
  })
  .strict();

export const AutomationUpdateBody = z
  .object({
    agentId: Id.optional(),
    name: Name.optional(),
    prompt: Prompt.optional(),
    trigger: AutomationTriggerInput.optional(),
    /** The task's own zone (an explicit change). */
    timeZone: IanaTimeZone.optional(),
    mode: Mode.optional(),
    conversationId: Id.nullable().optional(),
    chat: AutomationChatInput.nullable().optional(),
    /** `new` mode only; switching to another mode clears them. */
    model: AutomationModel.nullable().optional(),
    effort: AutomationEffort.nullable().optional(),
    deviceId: Id.nullable().optional(),
    /** Null: the org's default expiry for a cron task (as on create), else never. */
    expiresAt: ExpiresAt.nullable().optional(),
  })
  .strict();

export const AutomationListQuery = z
  .object({
    all: z.enum(["true", "false"]).optional(),
    /** Only the tasks that post into this conversation (the conversation's side panel). */
    conversationId: Id.optional(),
  })
  .strict();
/** An instant with an offset (`2026-11-09T00:00:00+08:00`). */
const Instant = z.string().datetime({ offset: true });

/**
 * The calendar's range (`from < to`, at most 43 days, 2 with `taskId`: checked by the service),
 * the viewer's zone (local days for the collapse and the cut), `all` (org admins) and `taskId`
 * (one task, never collapsed).
 */
export const AutomationCalendarQuery = z
  .object({
    from: Instant,
    to: Instant,
    timeZone: IanaTimeZone,
    all: z.enum(["true", "false"]).optional(),
    taskId: Id.optional(),
  })
  .strict();
export const AutomationChatTargetsQuery = z.object({}).strict();
export const AutomationGrantableQuery = z.object({ agentId: Id }).strict();
export const AutomationParams = z.object({ id: Id });
export const AutomationRunBody = z.object({ trial: z.boolean().optional() }).strict();
export const AutomationRunsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();
export const AutomationGrantsBody = z
  .object({ grants: z.array(AutomationGrantInput).min(1).max(50) })
  .strict();
export const AutomationGrantParams = z.object({ id: Id, toolKey: z.string().min(1).max(270) });

export class AutomationCreateBodyDto extends createZodDto(
  AutomationCreateBody,
  "AutomationCreateBody",
) {}
export class AutomationUpdateBodyDto extends createZodDto(
  AutomationUpdateBody,
  "AutomationUpdateBody",
) {}
export class AutomationListQueryDto extends createZodDto(
  AutomationListQuery,
  "AutomationListQuery",
) {}
export class AutomationCalendarQueryDto extends createZodDto(
  AutomationCalendarQuery,
  "AutomationCalendarQuery",
) {}
export class AutomationChatTargetsQueryDto extends createZodDto(
  AutomationChatTargetsQuery,
  "AutomationChatTargetsQuery",
) {}
export class AutomationGrantableQueryDto extends createZodDto(
  AutomationGrantableQuery,
  "AutomationGrantableQuery",
) {}
export class AutomationParamsDto extends createZodDto(AutomationParams, "AutomationParams") {}
export class AutomationRunBodyDto extends createZodDto(AutomationRunBody, "AutomationRunBody") {}
export class AutomationRunsQueryDto extends createZodDto(
  AutomationRunsQuery,
  "AutomationRunsQuery",
) {}
export class AutomationGrantsBodyDto extends createZodDto(
  AutomationGrantsBody,
  "AutomationGrantsBody",
) {}
export class AutomationGrantParamsDto extends createZodDto(
  AutomationGrantParams,
  "AutomationGrantParams",
) {}

/** The automation routes the Platform operations mirror (`check:platform-ops` keys). */
export const AUTOMATION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/automations", query: AutomationListQuery },
  { route: "GET /api/v1/orgs/:orgId/automations/calendar", query: AutomationCalendarQuery },
  { route: "GET /api/v1/orgs/:orgId/automations/chat-targets", query: AutomationChatTargetsQuery },
  { route: "GET /api/v1/orgs/:orgId/automations/grantable-tools", query: AutomationGrantableQuery },
  { route: "POST /api/v1/orgs/:orgId/automations", body: AutomationCreateBody },
  { route: "GET /api/v1/orgs/:orgId/automations/:id", params: AutomationParams },
  {
    route: "PATCH /api/v1/orgs/:orgId/automations/:id",
    params: AutomationParams,
    body: AutomationUpdateBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/automations/:id", params: AutomationParams },
  { route: "POST /api/v1/orgs/:orgId/automations/:id/pause", params: AutomationParams },
  { route: "POST /api/v1/orgs/:orgId/automations/:id/resume", params: AutomationParams },
  {
    route: "POST /api/v1/orgs/:orgId/automations/:id/run",
    params: AutomationParams,
    body: AutomationRunBody,
  },
  {
    route: "GET /api/v1/orgs/:orgId/automations/:id/runs",
    params: AutomationParams,
    query: AutomationRunsQuery,
  },
  { route: "GET /api/v1/orgs/:orgId/automations/:id/grants", params: AutomationParams },
  {
    route: "POST /api/v1/orgs/:orgId/automations/:id/grants",
    params: AutomationParams,
    body: AutomationGrantsBody,
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/automations/:id/grants/:toolKey",
    params: AutomationGrantParams,
  },
];

/** The object without its undefined properties (the service's inputs take absent, not undefined). */
export function defined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** A grant list as the service's input. */
export const grantsOf = (grants: z.infer<typeof AutomationGrantsBody>["grants"]): GrantInput[] =>
  grants.map((g) => defined(g) as GrantInput);

/**
 * A create body as the service's input. `timeZone` is the browser zone and is not part of it: the
 * service uses it only when the account has no zone (spec §5), so it is returned separately.
 */
export function createInputOf(body: z.infer<typeof AutomationCreateBody>): {
  input: CreateTaskInput;
  browserTimeZone: string | undefined;
} {
  const { timeZone, expiresAt, grants, ...rest } = body;
  return {
    input: {
      ...defined(rest),
      ...(expiresAt !== undefined && {
        expiresAt: expiresAt === null ? null : new Date(expiresAt),
      }),
      ...(grants !== undefined && { grants: grantsOf(grants) }),
    } as CreateTaskInput,
    browserTimeZone: timeZone,
  };
}

/** A patch body as the service's input (an explicit `timeZone` changes the task's zone). */
export function updateInputOf(body: z.infer<typeof AutomationUpdateBody>): UpdateTaskInput {
  const { expiresAt, ...rest } = body;
  return {
    ...defined(rest),
    ...(expiresAt !== undefined && { expiresAt: expiresAt === null ? null : new Date(expiresAt) }),
  } as UpdateTaskInput;
}

/** A calendar query as the service's input. */
export const calendarInputOf = (q: z.infer<typeof AutomationCalendarQuery>) => ({
  from: new Date(q.from),
  to: new Date(q.to),
  timeZone: q.timeZone,
  all: q.all === "true",
  ...(q.taskId !== undefined && { taskId: q.taskId }),
});
