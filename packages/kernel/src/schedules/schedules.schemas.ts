import { z } from "zod";
import { ModelRef } from "../agents/definition.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { IanaTimeZone } from "../time-zone.js";
import type { CreateTaskInput, GrantInput, UpdateTaskInput } from "./scheduled-tasks.service.js";

/** Longest task name and prompt, in characters (the same bounds as the service). */
export const SCHEDULE_NAME_MAX = 200;
export const SCHEDULE_PROMPT_MAX = 20_000;

const Id = z.string().min(1).max(100);

/**
 * When a task fires, before the zone is fixed: a 5-field cron, or a local date-time
 * (`2026-12-01T09:00`, no offset) for a one-off run.
 */
export const ScheduleTriggerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("once"), at: z.string().trim().min(1).max(40) }).strict(),
]);

/** The IM chat a `chat`-mode task posts into. */
export const ScheduleChatInput = z
  .object({
    connectionId: Id,
    chatId: z.string().min(1).max(500),
    chatType: z.enum(["dm", "group"]),
  })
  .strict();

/** A model pick: the same `{ provider, model }` an agent's definition uses (strings bounded). */
export const ScheduleModel = ModelRef.strict().refine(
  (m) =>
    m.provider.length >= 1 &&
    m.provider.length <= 100 &&
    m.model.length >= 1 &&
    m.model.length <= 200,
  "provider is 1-100 and model 1-200 characters",
);

export const ScheduleEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** An end time as an ISO 8601 timestamp with an offset (`2026-12-31T00:00:00Z`). */
const ExpiresAt = z.string().datetime({ offset: true });

/** A tool the creator pre-approves for the task. */
export const ScheduleGrantInput = z
  .object({ toolKey: z.string().trim().min(1).max(200), connectorId: Id.optional() })
  .strict();

const Name = z.string().trim().min(1).max(SCHEDULE_NAME_MAX);
const Prompt = z.string().trim().min(1).max(SCHEDULE_PROMPT_MAX);
const Mode = z.enum(["new", "conversation", "chat"]);

export const ScheduleCreateBody = z
  .object({
    agentId: Id,
    name: Name,
    prompt: Prompt,
    trigger: ScheduleTriggerInput,
    /** The browser's zone: used only when the account has no zone of its own. */
    timeZone: IanaTimeZone.optional(),
    mode: Mode,
    conversationId: Id.optional(),
    chat: ScheduleChatInput.optional(),
    model: ScheduleModel.optional(),
    effort: ScheduleEffort.optional(),
    deviceId: Id.optional(),
    expiresAt: ExpiresAt.nullable().optional(),
    grants: z.array(ScheduleGrantInput).max(50).optional(),
  })
  .strict();

export const ScheduleUpdateBody = z
  .object({
    agentId: Id.optional(),
    name: Name.optional(),
    prompt: Prompt.optional(),
    trigger: ScheduleTriggerInput.optional(),
    /** The task's own zone (an explicit change). */
    timeZone: IanaTimeZone.optional(),
    mode: Mode.optional(),
    conversationId: Id.nullable().optional(),
    chat: ScheduleChatInput.nullable().optional(),
    model: ScheduleModel.nullable().optional(),
    effort: ScheduleEffort.nullable().optional(),
    deviceId: Id.nullable().optional(),
    expiresAt: ExpiresAt.nullable().optional(),
  })
  .strict();

export const ScheduleListQuery = z
  .object({
    all: z.enum(["true", "false"]).optional(),
    /** Only the tasks that post into this conversation (the conversation's side panel). */
    conversationId: Id.optional(),
  })
  .strict();
export const ScheduleChatTargetsQuery = z.object({}).strict();
export const ScheduleGrantableQuery = z.object({ agentId: Id }).strict();
export const ScheduleParams = z.object({ id: Id });
export const ScheduleRunBody = z.object({ trial: z.boolean().optional() }).strict();
export const ScheduleRunsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();
export const ScheduleGrantsBody = z
  .object({ grants: z.array(ScheduleGrantInput).min(1).max(50) })
  .strict();
export const ScheduleGrantParams = z.object({ id: Id, toolKey: z.string().min(1).max(200) });

export class ScheduleCreateBodyDto extends createZodDto(ScheduleCreateBody, "ScheduleCreateBody") {}
export class ScheduleUpdateBodyDto extends createZodDto(ScheduleUpdateBody, "ScheduleUpdateBody") {}
export class ScheduleListQueryDto extends createZodDto(ScheduleListQuery, "ScheduleListQuery") {}
export class ScheduleChatTargetsQueryDto extends createZodDto(
  ScheduleChatTargetsQuery,
  "ScheduleChatTargetsQuery",
) {}
export class ScheduleGrantableQueryDto extends createZodDto(
  ScheduleGrantableQuery,
  "ScheduleGrantableQuery",
) {}
export class ScheduleParamsDto extends createZodDto(ScheduleParams, "ScheduleParams") {}
export class ScheduleRunBodyDto extends createZodDto(ScheduleRunBody, "ScheduleRunBody") {}
export class ScheduleRunsQueryDto extends createZodDto(ScheduleRunsQuery, "ScheduleRunsQuery") {}
export class ScheduleGrantsBodyDto extends createZodDto(ScheduleGrantsBody, "ScheduleGrantsBody") {}
export class ScheduleGrantParamsDto extends createZodDto(
  ScheduleGrantParams,
  "ScheduleGrantParams",
) {}

/** The schedule routes the Platform operations mirror (`check:platform-ops` keys). */
export const SCHEDULE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/schedules", query: ScheduleListQuery },
  { route: "GET /api/v1/orgs/:orgId/schedules/chat-targets", query: ScheduleChatTargetsQuery },
  { route: "GET /api/v1/orgs/:orgId/schedules/grantable-tools", query: ScheduleGrantableQuery },
  { route: "POST /api/v1/orgs/:orgId/schedules", body: ScheduleCreateBody },
  { route: "GET /api/v1/orgs/:orgId/schedules/:id", params: ScheduleParams },
  {
    route: "PATCH /api/v1/orgs/:orgId/schedules/:id",
    params: ScheduleParams,
    body: ScheduleUpdateBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/schedules/:id", params: ScheduleParams },
  { route: "POST /api/v1/orgs/:orgId/schedules/:id/pause", params: ScheduleParams },
  { route: "POST /api/v1/orgs/:orgId/schedules/:id/resume", params: ScheduleParams },
  {
    route: "POST /api/v1/orgs/:orgId/schedules/:id/run",
    params: ScheduleParams,
    body: ScheduleRunBody,
  },
  {
    route: "GET /api/v1/orgs/:orgId/schedules/:id/runs",
    params: ScheduleParams,
    query: ScheduleRunsQuery,
  },
  { route: "GET /api/v1/orgs/:orgId/schedules/:id/grants", params: ScheduleParams },
  {
    route: "POST /api/v1/orgs/:orgId/schedules/:id/grants",
    params: ScheduleParams,
    body: ScheduleGrantsBody,
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/schedules/:id/grants/:toolKey",
    params: ScheduleGrantParams,
  },
];

/** The object without its undefined properties (the service's inputs take absent, not undefined). */
export function defined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** A grant list as the service's input. */
export const grantsOf = (grants: z.infer<typeof ScheduleGrantsBody>["grants"]): GrantInput[] =>
  grants.map((g) => defined(g) as GrantInput);

/**
 * A create body as the service's input. `timeZone` is the browser zone and is not part of it: the
 * service uses it only when the account has no zone (spec §5), so it is returned separately.
 */
export function createInputOf(body: z.infer<typeof ScheduleCreateBody>): {
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
export function updateInputOf(body: z.infer<typeof ScheduleUpdateBody>): UpdateTaskInput {
  const { expiresAt, ...rest } = body;
  return {
    ...defined(rest),
    ...(expiresAt !== undefined && { expiresAt: expiresAt === null ? null : new Date(expiresAt) }),
  } as UpdateTaskInput;
}
