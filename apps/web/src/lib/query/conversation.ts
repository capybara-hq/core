import type { DehydratedState, QueryClient, UseQueryOptions } from "@tanstack/react-query";
import { listModels } from "../agents";
import { ApiClientError } from "../api";
import { getApproval } from "../approvals";
import { getSandboxStatus } from "../artifacts";
import { getAttachmentLimits } from "../attachments";
import {
  getConnector,
  listConnectorKinds,
  listConnectorPrompts,
  listConnectorResources,
  listConnectors,
} from "../connectors";
import {
  type BackgroundTaskOutput,
  type Conversation,
  type ConversationEvent,
  getAgentTree,
  getConversation,
  getConversationUsage,
  getToolInfo,
  listAllEvents,
  listBackgroundTasks,
  listQueue,
  listSubagents,
  readBackgroundTaskOutput,
  readToolOutput,
  renameConversation,
  type ToolInfo,
  toolOutputSize,
} from "../conversations";
import { fileText, listFiles } from "../files";
import { listFilePreviewers, renderFilePreview } from "../previewers";
import { getQuestion } from "../questions";
import { listInvocableSkills } from "../skills";
import { toolKeysOf } from "../tool-keys";
import { listUiContributions, type UiLocale } from "../ui";
import { defineQuery } from "./define";
import { keys } from "./keys";
import { membersQuery } from "./members";

/**
 * The conversation page's reads (web query cache spec §5, §6): the row and the event log, the
 * pieces outside the log (queue, files, sandbox, sub-agents, usage, tool info) and the org's
 * configuration the page shows (models, connectors, contributions, limits, skills).
 */

/** The conversation row (title, agent, selection). */
export const conversationQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).row(),
    fn: () => getConversation(orgId, id).then((r) => r.conversation),
    freshness: "live",
  });

/**
 * Every event of the log, in seq order; the stream appends to it ({@link appendEvents}). Never
 * refetched wholesale while cached (`events` freshness), and a later hydration merges into it
 * ({@link mergeHydratedEvents}) instead of replacing what the stream appended.
 */
export const eventsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).events(),
    fn: () => listAllEvents(orgId, id),
    freshness: "events",
  });

/** Messages an older version queued (leftovers the kernel still sends) and whether they are paused. */
export const queueQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).queue(),
    fn: () =>
      listQueue(orgId, id).then((r) => ({
        items: r.items,
        paused: r.paused,
        ...(r.pauseReason !== undefined ? { pauseReason: r.pauseReason } : {}),
      })),
    freshness: "live",
  });

/** The conversation's file outputs (the kernel's order: newest first by first delivery). */
export const filesQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).files(),
    fn: () => listFiles(orgId, id),
    freshness: "live",
  });

/** The sandbox's status; `null` without a sandbox. */
export const sandboxQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).sandbox(),
    fn: () => getSandboxStatus(orgId, id),
    freshness: "live",
  });

/** The sub-agents, newest first (read once one was dispatched). */
export const subagentsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).subagents(),
    fn: () => listSubagents(orgId, id).then((r) => r.subagents),
    freshness: "live",
  });

/** The agent tree of a root conversation (the agent map's level 1; read while the map is open). */
export const agentTreeQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).agentTree(),
    fn: () => getAgentTree(orgId, id).then((r) => r.root),
    freshness: "live",
  });

/** The tokens with the sub-agents' (read once one was dispatched). */
export const usageQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).usage(),
    fn: () => getConversationUsage(orgId, id).then((r) => r.usage),
    freshness: "live",
  });

/**
 * Whether the log names background tasks the background section reads (background Bash spec §5):
 * a `Bash` call with `run_in_background: true`, a `background_task_finished`, or a dispatched
 * sub-agent (whose own tasks the section nests under it; they are in the child's log, not here).
 */
export function hasBackgroundTasks(events: readonly ConversationEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "background_task_finished" ||
      e.type === "subagent_dispatched" ||
      (e.type === "assistant_message" &&
        e.payload.content.some(
          (b) =>
            b.type === "tool_call" &&
            b.name === "Bash" &&
            typeof b.input === "object" &&
            b.input !== null &&
            (b.input as Record<string, unknown>).run_in_background === true,
        )),
  );
}

/** The background tasks, the conversation's and its sub-agents', newest first. */
export const backgroundTasksQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).background(),
    fn: () => listBackgroundTasks(orgId, id).then((r) => r.tasks),
    freshness: "live",
  });

/** How often the output panel reads a running task's output again. */
export const TASK_OUTPUT_POLL_MS = 2000;

/**
 * A task's output tail; `null` when nothing is readable now (409
 * `background_task.output_unavailable`: the sandbox is suspended or gone). Polled every
 * {@link TASK_OUTPUT_POLL_MS} while the task runs ({@link taskOutputPollMs}); `changed: background`
 * reads it once more when the task finishes.
 */
export const taskOutputQuery = (orgId: string, id: string, taskId: string) =>
  defineQuery<BackgroundTaskOutput | null>({
    key: keys.org(orgId).conversation(id).backgroundOutput(taskId),
    fn: () =>
      readBackgroundTaskOutput(orgId, id, taskId).catch((e: unknown) => {
        if (e instanceof ApiClientError && e.code === "background_task.output_unavailable")
          return null;
        throw e;
      }),
    freshness: "live",
  });

/** The output query's `refetchInterval`: every 2 s while the task runs, never once it ended. */
export const taskOutputPollMs = (status: string | undefined): number | false =>
  status === "running" ? TASK_OUTPUT_POLL_MS : false;

/** The most keys one `GET …/tools?keys=` takes (kernel `TOOL_INFO_MAX_KEYS`). */
const TOOL_BATCH = 100;

/** Display metadata of the tools `toolKeys` name (in batches); the key holds them sorted. */
export const toolInfoQuery = (orgId: string, id: string, toolKeys: readonly string[]) => {
  const sorted = [...toolKeys].sort();
  return defineQuery<ToolInfo[]>({
    key: keys.org(orgId).conversation(id).toolInfo(sorted),
    fn: async () => {
      const batches: string[][] = [];
      for (let i = 0; i < sorted.length; i += TOOL_BATCH)
        batches.push(sorted.slice(i, i + TOOL_BATCH));
      const answers = await Promise.all(batches.map((b) => getToolInfo(orgId, id, b)));
      return answers.flatMap((a) => a.tools);
    },
    freshness: "orgConfig",
  });
};

/**
 * The agent's invocable skills for the composer's `/` menu, with the conversation's trial drafts
 * when `conversationId` is the caller's own. A conversation the caller cannot read lists without it.
 */
export const invocableSkillsQuery = (orgId: string, agentId: string, conversationId?: string) =>
  defineQuery({
    key: keys.org(orgId).invocableSkills(agentId, conversationId ?? null),
    fn: () =>
      listInvocableSkills(orgId, agentId, conversationId)
        .catch((e: unknown) => {
          if (
            conversationId !== undefined &&
            e instanceof ApiClientError &&
            e.code === "conversation.not_found"
          )
            return listInvocableSkills(orgId, agentId);
          throw e;
        })
        .then((r) => r.skills),
    freshness: "orgConfig",
  });

/** The extensions' UI contributions (title-bar panels, properties sections, inline cards). */
export const contributionsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).contributions(),
    fn: () => listUiContributions(orgId).then((r) => r.items),
    freshness: "orgConfig",
  });

/** The org's connectors (`{ connectors }`, as the kernel answers). */
export const connectorsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).connectors(),
    fn: () => listConnectors(orgId),
    freshness: "orgConfig",
  });

/** The connector kinds the org can create connectors of (`{ kinds }`; org admins). */
export const connectorKindsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).connectorKinds(),
    fn: () => listConnectorKinds(orgId),
    freshness: "orgConfig",
  });

/** The attachment limits the composer checks files against. */
export const attachmentLimitsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).attachmentLimits(),
    fn: () => getAttachmentLimits(orgId),
    freshness: "orgConfig",
  });

/** The org's models by provider (`{ providers }`, as the kernel answers). */
export const modelsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).models(),
    fn: () => listModels(orgId),
    freshness: "orgConfig",
  });

/** A call's full archived output (paged in; `complete: false` past the most it reads). */
export const toolOutputQuery = (orgId: string, id: string, outputId: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).output(outputId, "text"),
    fn: () => readToolOutput(orgId, id, outputId),
    freshness: "events",
  });

/** The size (characters) of a call's archived output, for "View all". */
export const toolOutputSizeQuery = (orgId: string, id: string, outputId: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).output(outputId, "size"),
    fn: () => toolOutputSize(orgId, id, outputId),
    freshness: "events",
  });

/** The extension previewers that accept a file. */
export const filePreviewersQuery = (orgId: string, id: string, fileId: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).filePreviewers(fileId),
    fn: () => listFilePreviewers(orgId, id, fileId).then((r) => r.previewers),
    freshness: "orgConfig",
  });

/** A file's preview by an extension previewer (a rendered view). */
export const filePreviewQuery = (
  orgId: string,
  id: string,
  fileId: string,
  p: { plugin: string; id: string },
  locale: UiLocale,
) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).filePreview(fileId, `${p.plugin}/${p.id}`, locale),
    fn: () => renderFilePreview(orgId, id, fileId, p, locale).then((r) => r.view),
    freshness: "live",
  });

/** A file's text for the built-in previews (the first bytes; `truncated` past them). */
export const fileTextQuery = (orgId: string, id: string, fileId: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).filePreview(fileId, "builtin", ""),
    fn: ({ signal }) => fileText(orgId, id, fileId, signal),
    freshness: "live",
  });

/** One approval as its approver reads it (a viewer who may not decide gets a 404). */
export const approvalQuery = (orgId: string, approvalId: string) =>
  defineQuery({
    key: keys.org(orgId).approval(approvalId),
    fn: () => getApproval(orgId, approvalId).then((r) => r.approval),
    freshness: "live",
  });

/** One question (a sub-agent's, which the parent's log names only by id). */
export const questionQuery = (orgId: string, questionId: string) =>
  defineQuery({
    key: keys.org(orgId).question(questionId),
    fn: () => getQuestion(orgId, questionId).then((r) => r.question),
    freshness: "live",
  });

/** One connector's detail (its auth decides how Connect starts). */
export const connectorQuery = (orgId: string, connectorId: string) =>
  defineQuery({
    key: keys.org(orgId).connector(connectorId),
    fn: () => getConnector(orgId, connectorId).then((r) => r.connector),
    freshness: "orgConfig",
  });

/** The connectors' prompts for the composer's `/` menu. */
export const connectorPromptsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).connectorItems("prompts"),
    fn: () => listConnectorPrompts(orgId),
    freshness: "orgConfig",
  });

/** The connectors' resources for the composer's `@` menu. */
export const connectorResourcesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).connectorItems("resources"),
    fn: () => listConnectorResources(orgId),
    freshness: "orgConfig",
  });

/**
 * What the conversation page reads once it has the log and the row (the route's `then`, as
 * today's snapshot did): the tool info the events name, the sub-agents and usage once one was
 * dispatched, the background tasks once the log names one ({@link hasBackgroundTasks}), the
 * members once a run another account stopped shows, and the agent's invocable
 * skills (with the conversation's trial drafts when it is the caller's).
 */
export function conversationFollowUps(
  orgId: string,
  id: string,
  events: readonly ConversationEvent[],
  row: Conversation,
  accountId: string | undefined,
): UseQueryOptions<unknown, ApiClientError>[] {
  const out: UseQueryOptions<unknown, ApiClientError>[] = [];
  const add = <T>(o: UseQueryOptions<T, ApiClientError>) =>
    out.push(o as unknown as UseQueryOptions<unknown, ApiClientError>);
  const tools = toolKeysOf(events);
  if (tools.length > 0) add(toolInfoQuery(orgId, id, tools));
  if (events.some((e) => e.type === "subagent_dispatched")) {
    add(subagentsQuery(orgId, id));
    add(usageQuery(orgId, id));
  }
  if (hasBackgroundTasks(events)) add(backgroundTasksQuery(orgId, id));
  const stoppedByOther = events.some(
    (e) =>
      e.type === "run_aborted" &&
      e.payload.byAccountId !== null &&
      e.payload.byAccountId !== accountId,
  );
  if (stoppedByOther) add(membersQuery(orgId));
  const mine = row.accountId === undefined || row.accountId === accountId;
  add(invocableSkillsQuery(orgId, row.agentId, mine ? id : undefined));
  return out;
}

/** `a` and `b` merged by seq: none twice, ascending. */
function mergeBySeq(
  a: readonly ConversationEvent[],
  b: readonly ConversationEvent[],
): ConversationEvent[] {
  const bySeq = new Map<number, ConversationEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

const isEventsKey = (k: readonly unknown[]) =>
  k.length === 5 && k[0] === "org" && k[2] === "conversation" && k[4] === "events";

/**
 * A dehydrated state (a later server render: `router.refresh()`) with every conversation log the
 * cache already holds merged into it, so hydrating it never drops events the stream appended
 * after the server read: the cached list and the server's are united by seq.
 */
export function mergeHydratedEvents(qc: QueryClient, state: DehydratedState): DehydratedState {
  return {
    ...state,
    queries: state.queries.map((q) => {
      if (!isEventsKey(q.queryKey)) return q;
      const cached = qc.getQueryData<ConversationEvent[]>(q.queryKey);
      const incoming = q.state.data as ConversationEvent[] | undefined;
      if (cached === undefined || incoming === undefined) return q;
      return { ...q, state: { ...q.state, data: mergeBySeq(cached, incoming) } };
    }),
  };
}

/**
 * Merges `events` into the cached log of the conversation by `seq`: none twice, in ascending
 * order. Returns how many were new. Nothing happens while the log is not cached (the stream opens
 * only once it is).
 */
export function appendEvents(
  qc: QueryClient,
  orgId: string,
  id: string,
  events: readonly ConversationEvent[],
): { added: number } {
  let added = 0;
  qc.setQueryData<ConversationEvent[]>(keys.org(orgId).conversation(id).events(), (cur) => {
    if (cur === undefined || events.length === 0) return cur;
    const last = cur.at(-1)?.seq ?? 0;
    const incoming = [...events].sort((a, b) => a.seq - b.seq);
    // The stream's usual case: everything is newer than the log's end.
    if ((incoming[0] as ConversationEvent).seq > last) {
      const fresh = incoming.filter((e, i) => i === 0 || e.seq !== incoming[i - 1]?.seq);
      added = fresh.length;
      return [...cur, ...fresh];
    }
    const seen = new Set(cur.map((e) => e.seq));
    const fresh: ConversationEvent[] = [];
    for (const e of incoming) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      fresh.push(e);
    }
    added = fresh.length;
    if (added === 0) return cur;
    return [...cur, ...fresh].sort((a, b) => a.seq - b.seq);
  });
  return { added };
}

/**
 * Reads what the cached log lacks after its end and merges it ({@link appendEvents}): a resync
 * that never replaces the cache, so an event the stream appends meanwhile survives (the log is
 * never refetched wholesale, {@link eventsQuery}). Nothing is read while the log is not cached.
 */
export async function catchUpEvents(
  qc: QueryClient,
  orgId: string,
  id: string,
): Promise<{ added: number }> {
  const cached = qc.getQueryData<ConversationEvent[]>(keys.org(orgId).conversation(id).events());
  if (cached === undefined) return { added: 0 };
  const events = await listAllEvents(orgId, id, cached.at(-1)?.seq ?? 0);
  return appendEvents(qc, orgId, id, events);
}

/**
 * The messages this tab sent to a conversation, by `clientMessageId`, with this tab's clock at the
 * send (`Date.now()`; per query client, in the browser): the working line and the composer's
 * running mode wait for their runs, at most 60 s from that time (conversation send spec §2.2;
 * never against the server's `createdAt`, which another clock wrote). It survives the `/chat` →
 * `/chat/<id>` handoff (the seed adds the first message); a send the kernel refused is removed
 * again. Never sent to the server.
 */
const sentBy = new WeakMap<QueryClient, Map<string, Map<string, number>>>();
export function sentHereOf(qc: QueryClient, orgId: string, id: string): Map<string, number> {
  let byConv = sentBy.get(qc);
  if (byConv === undefined) {
    byConv = new Map();
    sentBy.set(qc, byConv);
  }
  const scope = `${orgId}/${id}`;
  let sent = byConv.get(scope);
  if (sent === undefined) {
    sent = new Map();
    byConv.set(scope, sent);
  }
  return sent;
}

/**
 * A conversation just created with its first message (conversation send spec §2.1): the create's
 * answer is the row and every event the create wrote (`events`, from seq 1: a `model_switched`
 * before the message when the send switched; an older kernel answers only `event`), and a new
 * conversation has an empty queue, no files and no sandbox, so those are known answers too and
 * `/chat/<id>` reads none of them; its stream opens after the last event's seq. A log that does
 * not start at seq 1 (an older kernel's `event` after a switch) holds events the answer did not
 * carry: it is then not seeded and the page reads it whole.
 */
export function seedNewConversation(
  qc: QueryClient,
  orgId: string,
  conversation: Conversation,
  answer: { event: ConversationEvent; events?: readonly ConversationEvent[] },
  /** This tab's clock when the message was sent (default: now). */
  sentAt: number = Date.now(),
): void {
  const c = keys.org(orgId).conversation(conversation.id);
  const { event } = answer;
  if (event.type === "user_message" && event.payload.clientMessageId !== undefined)
    sentHereOf(qc, orgId, conversation.id).set(event.payload.clientMessageId, sentAt);
  qc.setQueryData<Conversation>(c.row(), conversation);
  const log = [...(answer.events ?? [event])].sort((a, b) => a.seq - b.seq);
  const whole = log.every((e, i) => e.seq === i + 1);
  if (whole) {
    qc.setQueryData<ConversationEvent[]>(c.events(), (cur) => cur ?? []);
    appendEvents(qc, orgId, conversation.id, log);
  }
  const empty = <T>(key: readonly unknown[], value: T) => {
    if (qc.getQueryData(key) === undefined) qc.setQueryData<T>(key, value);
  };
  empty(c.queue(), { items: [], paused: false });
  empty(c.files(), []);
  empty(c.sandbox(), null);
  let marks = seededAt.get(qc);
  if (marks === undefined) {
    marks = new Map();
    seededAt.set(qc, marks);
  }
  marks.set(`${orgId}/${conversation.id}`, Date.now());
}

/**
 * Conversations whose cache {@link seedNewConversation} just seeded, by `<orgId>/<id>`, with the
 * seed's time: their first stream open is no catch-up (nothing outside the log can have changed
 * since the answer), so it invalidates no side key and checks no title.
 */
const seededAt = new WeakMap<QueryClient, Map<string, number>>();
/** How long after the seed the stream's first events still count as the answer's own run. */
const SEEDED_WINDOW_MS = 10_000;
export function isFreshlySeeded(qc: QueryClient, orgId: string, id: string): boolean {
  const at = seededAt.get(qc)?.get(`${orgId}/${id}`);
  return at !== undefined && Date.now() - at < SEEDED_WINDOW_MS;
}

/**
 * What a reopened stream's catch-up makes stale when it delivered events (spec §6, "Returning to
 * a conversation"): the queue, files, sandbox, sub-agents, the agent tree, usage, background
 * tasks, the row, the tool info and the conversation's extension views. Otherwise they follow
 * their freshness class.
 */
export const CONVERSATION_SIDE_KEYS = (orgId: string, id: string): (readonly unknown[])[] => {
  const c = keys.org(orgId).conversation(id);
  return [
    c.queue(),
    c.files(),
    c.sandbox(),
    c.subagents(),
    c.agentTree(),
    c.usage(),
    c.background(),
    c.row(),
    c.toolInfoAll(),
    keys.org(orgId).uiViews(id),
  ];
};

/**
 * Renames a conversation with its cached row taking the title first: the stream's `changed: title`
 * for this rename then finds the row unchanged and reads the sidebar's groups no second time. The
 * answer replaces the row; a failure restores the row as it was. A row not cached is left alone.
 */
export async function renameWithRow(
  qc: QueryClient,
  orgId: string,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  const rowKey = keys.org(orgId).conversation(conversationId).row();
  // A read of the row in flight would land over the new title (or revert to its state later).
  await qc.cancelQueries({ queryKey: rowKey });
  const before = qc.getQueryData<Conversation>(rowKey);
  if (before !== undefined) qc.setQueryData<Conversation>(rowKey, { ...before, title });
  try {
    const { conversation } = await renameConversation(orgId, conversationId, title);
    if (before !== undefined) qc.setQueryData<Conversation>(rowKey, conversation);
    return conversation;
  } catch (e) {
    if (before !== undefined) qc.setQueryData<Conversation>(rowKey, before);
    throw e;
  }
}
