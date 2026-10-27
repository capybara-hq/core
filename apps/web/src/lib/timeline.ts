import {
  type DiffData,
  type SubagentFinishStatus,
  type SubagentRowData,
  type SubagentWaitKind,
  subagentStatusOfFinish,
  type ToolRowData,
} from "@capybara-hq/design";
import type {
  ApprovalPolicy,
  ContentBlock,
  ConversationEvent,
  InputForm,
  MessageAttachment,
  ModelRef,
  ToolInfo,
} from "./conversations";

/**
 * The conversation timeline (UI refresh B, spec §5.5–§5.8): the one pure builder that turns the
 * event log (plus the streaming drafts) into what the thread renders. Pages never group tool calls
 * themselves.
 *
 * - Consecutive tool calls form one `tools` entry; prose, thinking, a user message, a
 *   human-in-the-loop item or a divider ends the group. Prose is never folded into a group.
 * - A call's `artifact_created` files and its inline card (`tool_result.card`) land right after the
 *   group that holds the call (files first).
 * - `hook_denied` with a `callId` marks that row as blocked by the extension.
 * - `run_aborted`, `run_failed`, `compaction_summary` and `model_switched { reason: "unavailable" }`
 *   become dividers. A `user_message` with `retryOf` folds into the failed divider of the message it
 *   repeats ("Retried") instead of a second bubble.
 * - Logs written before UI refresh B (no `description`, `view`, title or card) still render: rows
 *   fall back to the tool key and the first string argument, failures to `isError`.
 * - Sub-agents (phase C, Task 21): consecutive `agent` calls form one `subagents` entry, its rows
 *   from `subagent_dispatched` / `subagent_finished` (plus live progress and the sub-agents list),
 *   the call's result as the in-place summary; a call refused before any dispatch is a failed row.
 *   `subagent_waiting` puts the child's approval, question or connection into the parent; a child's
 *   task message (`user_message.dispatch`) is a `task` entry.
 * - Skill invocations (phase D): a person's `user_message` with `skill` is a bubble with the skill
 *   chip, the arguments as typed and, inline, the rendered instructions (`content[0]`; a fork's
 *   `content[0]` is the lead, and its instructions are the child's task). A fork's dispatch
 *   (`subagent_dispatched.invokedSeq`, no `agent` call) is a sub-agent row at its log position,
 *   its `skill_fork_result` a `skill-report` entry. A plain message that a later fork's run took
 *   in, not yet sent to the model while that sub-agent works, says it waits for it (`waitsFor`).
 *   A sub-agent's task message carries the `skill` record too and stays a `task`.
 */

export type ApprovalDecision = Extract<ConversationEvent, { type: "approval_decided" }>["payload"];
export type QuestionOutcome = Extract<ConversationEvent, { type: "question_answered" }>["payload"];

/** A file uploaded with a user message (an image / document reference block). */
export interface MessageFile {
  attachmentId: string;
  kind: "image" | "document";
  mediaType: string;
  name: string;
}

/** A file the agent delivered (`artifact_created`). */
export interface FileRef {
  id: string;
  name: string;
  contentType: string;
  size: number;
  callId: string;
  sourcePath: string;
}

/** A sub-agent row plus the `agent` call it came from. */
export interface TimelineSubagent {
  row: SubagentRowData;
  callId: string;
  input: unknown;
}

/**
 * What the page knows besides the log: the latest `subagent_progress` per sub-agent and the
 * sub-agents list (`GET …/subagents`), whose status shows a waiting or queued child.
 */
export interface SubagentLive {
  progress?: Readonly<Record<string, { toolCalls: number }>>;
  views?: ReadonlyMap<
    string,
    { status: string; pendingApprovalIds: string[]; pendingQuestionIds: string[] }
  >;
}

/** Longest agent result kept as a row's in-place summary (the panel has the whole record). */
const SUBAGENT_RESULT_MAX = 600;

/** A tool row plus what the container needs to act on it. */
export interface TimelineTool {
  row: ToolRowData;
  callId: string;
  toolKey: string;
  input: unknown;
  /** The archive of a cut output (`read_tool_output`), or null. */
  outputId: string | null;
  /** A read's line range; the thread shows it as the row's extra through i18n (m10). */
  lines?: { from: number; to: number };
}

export interface ApprovalItem {
  approvalId: string;
  callId: string;
  toolKey: string;
  input: unknown;
  expiresAt: string;
  policy?: ApprovalPolicy;
  decided: ApprovalDecision | null;
  decidedAt: string | null;
}

export interface QuestionItem {
  questionId: string;
  callId: string;
  form: InputForm;
  expiresAt: string;
  answered: QuestionOutcome | null;
}

export interface ConnectItem {
  callId: string;
  connectorId: string;
  connectorName: string;
  /** The run already ended (a card in the history no longer offers Connect). */
  closed: boolean;
}

export type DividerData =
  | { divider: "stopped"; byAccountId: string | null; at: string }
  | {
      divider: "failed";
      code: string;
      /** The kernel's message, shown for the pinned-skill failure only. */
      message: string;
      at: string;
      /** The last user message before the failure (what Retry repeats), or null. */
      retry: RetryMessage | null;
      /** A later message retried it. */
      retried: boolean;
    }
  | { divider: "hook-denied"; plugin: string | null; reason: string | null; at: string }
  | { divider: "compacted"; summary: string; savedTokens: number | null }
  | { divider: "fallback"; from: ModelRef | null; to: ModelRef | null };

/** What Retry repeats: the text (an invocation's arguments), files and the skill invoked. */
export interface RetryMessage {
  seq: number;
  text: string;
  files: MessageFile[];
  /** A skill invocation: the name to invoke again (`<plugin>:<name>` for a plugin's skill). */
  skill?: string;
}

export type TimelineEntry =
  | {
      kind: "user";
      key: string;
      seq: number;
      /** What the person typed (an invocation's arguments). */
      text: string;
      files: MessageFile[];
      attachments: MessageAttachment[];
      /** A skill invocation (phase D): the chip ("/fix-issue") and how it runs. */
      skill?: { label: string; mode: "inline" | "fork" };
      /** An inline invocation's rendered text, sent in the person's name (`content[0]`). */
      instructions?: string;
      /** A plain message a later fork's run took in: answered after that sub-agent ("/review"). */
      waitsFor?: string;
    }
  | {
      /** The report of the sub-agent that ran a person's fork invocation (phase D). */
      kind: "skill-report";
      key: string;
      text: string;
    }
  | { kind: "prose"; key: string; text: string; streaming: boolean }
  | {
      kind: "thinking";
      key: string;
      text: string;
      seconds: number | null;
      live: boolean;
      /** The model that thought (decides whether thinking shows), or null. */
      model: ModelRef | null;
    }
  | { kind: "tools"; key: string; rows: TimelineTool[] }
  | { kind: "subagents"; key: string; rows: TimelineSubagent[] }
  | {
      /** A sub-agent waits for a person: its approval, question or connection, in the parent. */
      kind: "subagent-wait";
      key: string;
      subagent: { id: string; name: string };
      wait: SubagentWaitKind;
      approvalId?: string;
      questionId?: string;
      toolKey: string;
      expiresAt?: string;
    }
  | { kind: "task"; key: string; seq: number; text: string }
  | { kind: "approval"; key: string; item: ApprovalItem }
  | { kind: "question"; key: string; item: QuestionItem }
  | { kind: "connect"; key: string; item: ConnectItem }
  | { kind: "card"; key: string; plugin: string; view: string; callId: string; cardKey?: string }
  | { kind: "files"; key: string; files: FileRef[] }
  | ({ kind: "divider"; key: string } & DividerData);

/** A streaming draft (`event: delta`), not in the log yet. */
export interface TimelineDraft {
  runId: string;
  step: number;
  text: string;
  thinking: string;
}

const TERMINAL = new Set<ConversationEvent["type"]>(["run_finished", "run_failed", "run_aborted"]);
/** The builtin tool that dispatches sub-agents. */
export const AGENT_TOOL = "agent";
const stepKey = (runId: string, step: number) => `${runId}:${step}`;
const callKey = (runId: string | null, callId: string) => `${runId ?? ""}\u0000${callId}`;
/** A row id that is a call key (an `agent` call never dispatched), not a sub-agent id. */
export const isCallKey = (id: string) => id.includes("\u0000");

const joinText = (blocks: { type: string; text?: string }[], type: "text" | "thinking") =>
  blocks
    .filter((b) => b.type === type)
    .map((b) => b.text ?? "")
    .join("");

/** user_message image / document reference blocks (`base64` never reaches the log). */
export function messageFiles(content: ContentBlock[]): MessageFile[] {
  return content.flatMap((b): MessageFile[] =>
    (b.type === "image" || b.type === "document") && b.source.kind === "ref"
      ? [
          {
            attachmentId: b.source.attachmentId,
            kind: b.type,
            mediaType: b.mediaType,
            name: b.name ?? b.source.attachmentId,
          },
        ]
      : [],
  );
}

/** The text a person typed (with `@` resources only `content[0]`; their bodies stay folded). */
function userText(e: Extract<ConversationEvent, { type: "user_message" }>): string {
  const attachments = e.payload.attachments ?? [];
  return attachments.length > 0
    ? joinText(e.payload.content.slice(0, 1), "text")
    : joinText(e.payload.content, "text");
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const valueText = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** The key argument: the tool's first declared key argument, else the first string input. */
function keyArgOf(input: unknown, info: ToolInfo | undefined): string | undefined {
  const rec = asRecord(input);
  for (const k of info?.keyArgs ?? []) {
    if (Object.hasOwn(rec, k) && rec[k] !== undefined) return valueText(rec[k]);
  }
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string" && k !== "description") return v;
  }
  return undefined;
}

const firstLine = (s: string) =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

interface CallState {
  tool: TimelineTool;
  runId: string | null;
  started: number | null;
  done: boolean;
  /** The entry that holds the call (its `tools` group key). */
  group: string;
}

/**
 * Builds the timeline. `info` holds the tools' display metadata (title, kind, key arguments,
 * source) as far as it has been fetched; rows of unknown tools fall back to their key.
 */
export function buildTimeline(
  events: readonly ConversationEvent[],
  drafts: readonly TimelineDraft[],
  info: ReadonlyMap<string, ToolInfo>,
  locale: "zh" | "en",
  live: SubagentLive = {},
): TimelineEntry[] {
  return withDrafts(buildEventTimeline(events, info, locale, live), drafts);
}

/** The timeline of the log alone, plus what {@link withDrafts} needs to add the drafts. */
export interface EventTimeline {
  entries: TimelineEntry[];
  /** The model of a run's step (the thinking row of a draft names it). */
  modelOf(runId: string | null, step: number): ModelRef | null;
}

/**
 * The streaming drafts after the log's entries (they always come last). Cheap: the page memoizes
 * {@link buildEventTimeline} over the events and adds the drafts on each delta frame, so a token
 * does not rebuild the timeline (final review I3); the log's entry objects stay the same.
 */
export function withDrafts(base: EventTimeline, drafts: readonly TimelineDraft[]): TimelineEntry[] {
  const out = base.entries.slice();
  let added = false;
  for (const d of drafts) {
    if (d.text === "" && d.thinking === "") continue;
    added = true;
    if (d.thinking !== "") {
      out.push({
        kind: "thinking",
        key: `d${d.runId}:${d.step}:thinking`,
        text: d.thinking,
        seconds: null,
        live: d.text === "",
        model: base.modelOf(d.runId, d.step),
      });
    }
    if (d.text !== "") {
      out.push({ kind: "prose", key: `d${d.runId}:${d.step}`, text: d.text, streaming: true });
    }
  }
  return added ? out : base.entries;
}

/** The timeline of the log (no drafts); see {@link buildTimeline}. */
export function buildEventTimeline(
  events: readonly ConversationEvent[],
  info: ReadonlyMap<string, ToolInfo>,
  locale: "zh" | "en",
  live: SubagentLive = {},
): EventTimeline {
  const out: TimelineEntry[] = [];
  const closedRuns = new Set<string>();
  for (const e of events) if (TERMINAL.has(e.type) && e.runId !== null) closedRuns.add(e.runId);

  const models = new Map<string, ModelRef>();
  const modelOf = (runId: string | null, step: number): ModelRef | null =>
    runId === null ? null : (models.get(stepKey(runId, step)) ?? models.get(runId) ?? null);
  const stepStarted = new Map<string, number>();
  const calls = new Map<string, CallState>();
  const approvals = new Map<string, number>();
  const questions = new Map<string, number>();
  const modelDenials = new Map<string, { plugin: string; reason: string }>();
  /** Group key → files delivered by its calls / cards of its calls. */
  const groupFiles = new Map<string, FileRef[]>();
  const groupCards = new Map<string, Extract<TimelineEntry, { kind: "card" }>[]>();
  /** The last user message (Retry repeats it). */
  let lastUser: RetryMessage | null = null;
  /** Plain user bubbles by seq, and the fork invocations (phase D: who waits for a sub-agent). */
  const plainUsers: Extract<TimelineEntry, { kind: "user" }>[] = [];
  const forks = new Map<number, { label: string; dispatched: boolean; reported: boolean }>();
  /** The highest user seq a model call took in (`model_call.request.absorbedUpToSeq`). */
  let absorbed = 0;
  /** Failed dividers by the user seq they would retry. */
  const failedBySeq = new Map<number, number>();
  /** The model the person switched to (the `from` of a fallback). */
  let switched: ModelRef | null = null;
  /** A fallback divider waiting for its run's `run_started` (its `to`). */
  const fallbacks = new Map<string, number>();
  /** Usage of the latest compaction call (the `saved` of the next summary). */
  let compactionUsage: number | null = null;
  /** `agent` calls by (runId, callId). */
  const agentCalls = new Map<string, { sub: TimelineSubagent; runId: string | null }>();
  /** Sub-agent id → its latest dispatch's row and child run. */
  const subagentRows = new Map<
    string,
    { sub: TimelineSubagent; childRunId: string; finished: boolean }
  >();

  const openSubagents = (): Extract<TimelineEntry, { kind: "subagents" }> => {
    const last = out.at(-1);
    if (last?.kind === "subagents") return last;
    const g: Extract<TimelineEntry, { kind: "subagents" }> = {
      kind: "subagents",
      key: `s${out.length}`,
      rows: [],
    };
    out.push(g);
    return g;
  };

  const openGroup = (): Extract<TimelineEntry, { kind: "tools" }> => {
    const last = out.at(-1);
    if (last?.kind === "tools") return last;
    const g: Extract<TimelineEntry, { kind: "tools" }> = {
      kind: "tools",
      key: `g${out.length}`,
      rows: [],
    };
    out.push(g);
    return g;
  };

  for (const e of events) {
    const key = `e${e.seq}`;
    switch (e.type) {
      case "run_started":
        if (e.runId !== null) {
          models.set(e.runId, e.payload.model);
          const fb = fallbacks.get(e.runId);
          const d = fb === undefined ? undefined : out[fb];
          if (d?.kind === "divider" && d.divider === "fallback") d.to = e.payload.model;
        }
        break;
      case "model_call":
        absorbed = Math.max(absorbed, e.payload.request?.absorbedUpToSeq ?? 0);
        if (e.runId !== null) {
          const k = stepKey(e.runId, e.payload.step);
          models.set(k, { provider: e.payload.provider, model: e.payload.model });
          stepStarted.set(k, Date.parse(e.createdAt));
        }
        break;
      case "model_switched":
        if (e.payload.reason === "user") switched = e.payload.model;
        else {
          out.push({ kind: "divider", key, divider: "fallback", from: switched, to: null });
          if (e.runId !== null) fallbacks.set(e.runId, out.length - 1);
          switched = null;
        }
        break;
      case "user_message": {
        if (e.payload.dispatch !== undefined) {
          // A sub-agent's task (its parent's prompt), not a person's message.
          out.push({ kind: "task", key, seq: e.seq, text: userText(e) });
          break;
        }
        const skill = e.payload.skill;
        const text = skill ? skill.arguments : userText(e);
        const files = messageFiles(e.payload.content);
        const retryOf = e.payload.retryOf;
        const failed = retryOf === undefined ? undefined : failedBySeq.get(retryOf);
        const d = failed === undefined ? undefined : out[failed];
        if (d?.kind === "divider" && d.divider === "failed" && !d.retried) {
          // Folded into the failed divider ("Retried"), not a second bubble.
          d.retried = true;
        } else {
          const entry: Extract<TimelineEntry, { kind: "user" }> = {
            kind: "user",
            key,
            seq: e.seq,
            text,
            files,
            attachments: e.payload.attachments ?? [],
          };
          if (skill) {
            entry.skill = { label: `/${skill.name}`, mode: skill.mode };
            // A fork's content[0] is the lead for the model, not the instructions: those are the
            // sub-agent's task, which its row opens.
            if (skill.mode === "inline") {
              entry.instructions = joinText(e.payload.content.slice(0, 1), "text");
            }
          } else {
            plainUsers.push(entry);
          }
          out.push(entry);
        }
        if (skill?.mode === "fork") {
          forks.set(e.seq, { label: `/${skill.name}`, dispatched: false, reported: false });
        }
        lastUser = {
          seq: retryOf ?? e.seq,
          text,
          files,
          ...(skill ? { skill: skill.plugin ? `${skill.plugin}:${skill.name}` : skill.name } : {}),
        };
        break;
      }
      case "skill_fork_result": {
        const f = forks.get(e.payload.invokedSeq);
        if (f) f.reported = true;
        out.push({ kind: "skill-report", key, text: e.payload.text });
        break;
      }
      case "assistant_message": {
        const text = joinText(e.payload.content, "text");
        const thinking = joinText(e.payload.content, "thinking");
        const model = modelOf(e.runId, e.payload.step);
        if (thinking !== "") {
          const started =
            e.runId === null ? undefined : stepStarted.get(stepKey(e.runId, e.payload.step));
          const ended = Date.parse(e.createdAt);
          out.push({
            kind: "thinking",
            key: `${key}:thinking`,
            text: thinking,
            // Approximate: the log has no thinking end time, so the whole step's time.
            seconds:
              started === undefined || Number.isNaN(started) || Number.isNaN(ended)
                ? null
                : Math.max(0, (ended - started) / 1000),
            live: false,
            model,
          });
        }
        if (text !== "") out.push({ kind: "prose", key, text, streaming: false });
        for (const b of e.payload.content) {
          if (b.type !== "tool_call") continue;
          if (b.name === AGENT_TOOL) {
            const rec = asRecord(b.input);
            const sub: TimelineSubagent = {
              row: {
                id: callKey(e.runId, b.id),
                agentType:
                  typeof rec.subagent_type === "string" ? rec.subagent_type : "general-purpose",
                description: typeof rec.description === "string" ? rec.description : "",
                status: "queued",
                toolCalls: 0,
              },
              callId: b.id,
              input: b.input,
            };
            openSubagents().rows.push(sub);
            agentCalls.set(callKey(e.runId, b.id), { sub, runId: e.runId });
            continue;
          }
          const ti = info.get(b.name);
          const input = b.input;
          const rec = asRecord(input);
          const group = openGroup();
          const builtinVerb =
            ti?.source.kind === "builtin" && (ti.kind === "read" || ti.kind === "edit");
          const keyArg = keyArgOf(input, ti);
          const kind = ti?.kind ?? "tool";
          const command = kind === "command" && typeof rec.command === "string";
          const row: ToolRowData = {
            id: callKey(e.runId, b.id),
            kind,
            title: builtinVerb ? "" : (ti?.title ?? b.name),
            status: "pending",
            ...(ti?.source.kind === "connector" || ti?.source.kind === "extension"
              ? { source: ti.source.name }
              : {}),
            ...(keyArg !== undefined && keyArg !== "" ? { keyArg } : {}),
            ...(typeof rec.description === "string" && rec.description !== ""
              ? { description: rec.description }
              : {}),
            detail: {
              input: Object.entries(rec)
                .filter(([k]) => !(command && (k === "command" || k === "description")))
                .map(([k, v]): [string, string] => [k, valueText(v)]),
              ...(command ? { command: rec.command as string } : {}),
            },
          };
          const tool: TimelineTool = { row, callId: b.id, toolKey: b.name, input, outputId: null };
          group.rows.push(tool);
          calls.set(callKey(e.runId, b.id), {
            tool,
            runId: e.runId,
            started: null,
            done: false,
            group: group.key,
          });
        }
        break;
      }
      case "tool_call_started": {
        const c = calls.get(callKey(e.runId, e.payload.callId));
        if (c && c.tool.row.status === "pending") {
          c.tool.row.status = "running";
          c.started = Date.parse(e.createdAt);
          c.tool.row.startedAt = c.started;
        }
        break;
      }
      case "tool_result": {
        const a = agentCalls.get(callKey(e.runId, e.payload.callId));
        if (a) {
          const row = a.sub.row;
          // Refused before any dispatch (unknown type, limits): nothing ran.
          if (row.status === "queued") row.status = e.payload.isError ? "failed" : "completed";
          const result = e.payload.content;
          row.summary = {
            steps: [],
            result:
              result.length > SUBAGENT_RESULT_MAX
                ? `${result.slice(0, SUBAGENT_RESULT_MAX)}…`
                : result,
          };
          break;
        }
        const c = calls.get(callKey(e.runId, e.payload.callId));
        if (!c) break;
        const p = e.payload;
        const row = c.tool.row;
        const view = p.view;
        const exit = view?.kind === "command" ? view.exitCode : null;
        const failed =
          p.isError ||
          (view?.kind === "command" && (view.timedOut || (exit ?? 0) !== 0)) ||
          row.blockedBy !== undefined;
        row.status = failed ? "failed" : "done";
        c.done = true;
        const end = Date.parse(e.createdAt);
        if (c.started !== null && !Number.isNaN(end)) row.durationMs = Math.max(0, end - c.started);
        if (view?.kind === "command" && view.description) row.description = view.description;
        if (view?.kind === "edit") {
          row.added = view.added;
          row.removed = view.removed;
          row.keyArg = view.path;
          const diff: DiffData = { hunks: view.hunks, truncated: view.truncated };
          row.detail = { ...row.detail, diff };
        }
        if (view?.kind === "read") {
          row.keyArg = view.path;
          if (view.fromLine !== undefined && view.toLine !== undefined)
            c.tool.lines = { from: view.fromLine, to: view.toLine };
        }
        // An extension's display summary (`ToolResult.display`) reads as the row's extra.
        const summary = p.display?.summary[locale];
        if (
          typeof summary === "string" &&
          summary !== "" &&
          row.extra === undefined &&
          c.tool.lines === undefined
        )
          row.extra = summary;
        if (failed && row.blockedBy === undefined) row.error = firstLine(p.content);
        row.detail = {
          ...row.detail,
          output: p.content,
          ...(failed ? { errorText: p.content } : {}),
        };
        c.tool.outputId = p.outputId ?? null;
        if (p.card) {
          const list = groupCards.get(c.group) ?? [];
          list.push({
            kind: "card",
            key: `${key}:card`,
            plugin: p.card.plugin,
            view: p.card.view,
            callId: p.callId,
            ...(p.card.key !== undefined ? { cardKey: p.card.key } : {}),
          });
          groupCards.set(c.group, list);
        }
        break;
      }
      case "hook_denied":
        if (e.payload.mount === "tool.preExecute" && e.payload.callId !== undefined) {
          const c = calls.get(callKey(e.runId, e.payload.callId));
          if (c) {
            c.tool.row.blockedBy = e.payload.plugin;
            c.tool.row.status = "failed";
            c.tool.row.detail = { ...c.tool.row.detail, errorText: e.payload.reason };
          }
        } else if (e.payload.mount === "model.request" && e.runId !== null) {
          modelDenials.set(e.runId, { plugin: e.payload.plugin, reason: e.payload.reason });
        }
        break;
      case "artifact_created": {
        const c = calls.get(callKey(e.runId, e.payload.callId));
        const f: FileRef = {
          id: e.payload.artifactId,
          name: e.payload.name,
          contentType: e.payload.contentType,
          size: e.payload.size,
          callId: e.payload.callId,
          sourcePath: e.payload.sourcePath,
        };
        if (c) {
          const list = groupFiles.get(c.group) ?? [];
          list.push(f);
          groupFiles.set(c.group, list);
        } else {
          out.push({ kind: "files", key, files: [f] });
        }
        break;
      }
      case "subagent_dispatched": {
        const invokedSeq = e.payload.invokedSeq;
        if (invokedSeq !== undefined) {
          // a person's fork invocation: no `agent` call, the row stands at the dispatch
          const f = forks.get(invokedSeq);
          if (f) f.dispatched = true;
          const at = Date.parse(e.createdAt);
          const sub: TimelineSubagent = {
            row: {
              id: e.payload.subagentId,
              agentType: e.payload.agentType,
              description: e.payload.description,
              status: "running",
              toolCalls: 0,
              ...(Number.isNaN(at) ? {} : { startedAt: at }),
            },
            callId: e.payload.callId,
            input: undefined,
          };
          openSubagents().rows.push(sub);
          subagentRows.set(e.payload.subagentId, {
            sub,
            childRunId: e.payload.childRunId,
            finished: false,
          });
          break;
        }
        const a = agentCalls.get(callKey(e.runId, e.payload.callId));
        if (!a) break;
        const row = a.sub.row;
        row.id = e.payload.subagentId;
        row.agentType = e.payload.agentType;
        if (e.payload.description !== "") row.description = e.payload.description;
        row.status = "running";
        const at = Date.parse(e.createdAt);
        if (!Number.isNaN(at)) row.startedAt = at;
        subagentRows.set(e.payload.subagentId, {
          sub: a.sub,
          childRunId: e.payload.childRunId,
          finished: false,
        });
        break;
      }
      case "subagent_finished": {
        const s = subagentRows.get(e.payload.subagentId);
        if (!s || s.childRunId !== e.payload.childRunId) break;
        s.finished = true;
        const row = s.sub.row;
        row.status = subagentStatusOfFinish(e.payload.status as SubagentFinishStatus);
        delete row.waiting;
        row.toolCalls = e.payload.toolCalls;
        row.durationMs = e.payload.durationMs;
        const at = Date.parse(e.createdAt);
        if (!Number.isNaN(at)) row.finishedAt = at;
        break;
      }
      case "subagent_waiting": {
        const s = subagentRows.get(e.payload.subagentId);
        const row = s?.sub.row;
        if (s && row && !s.finished && s.childRunId === e.payload.childRunId) {
          row.status = "waiting";
          row.waiting = e.payload.kind;
        }
        out.push({
          kind: "subagent-wait",
          key,
          subagent: {
            id: e.payload.subagentId,
            name: row?.description || row?.agentType || e.payload.subagentId,
          },
          wait: e.payload.kind,
          toolKey: e.payload.toolKey,
          ...(e.payload.approvalId !== undefined ? { approvalId: e.payload.approvalId } : {}),
          ...(e.payload.questionId !== undefined ? { questionId: e.payload.questionId } : {}),
          ...(e.payload.expiresAt !== undefined ? { expiresAt: e.payload.expiresAt } : {}),
        });
        break;
      }
      case "approval_requested":
        approvals.set(e.payload.approvalId, out.length);
        out.push({
          kind: "approval",
          key,
          item: {
            approvalId: e.payload.approvalId,
            callId: e.payload.callId,
            toolKey: e.payload.toolKey,
            input: calls.get(callKey(e.runId, e.payload.callId))?.tool.input,
            expiresAt: e.payload.expiresAt,
            ...(e.payload.policy !== undefined ? { policy: e.payload.policy } : {}),
            decided: null,
            decidedAt: null,
          },
        });
        break;
      case "approval_decided": {
        const i = approvals.get(e.payload.approvalId);
        const prev = i === undefined ? undefined : out[i];
        if (i !== undefined && prev?.kind === "approval")
          out[i] = { ...prev, item: { ...prev.item, decided: e.payload, decidedAt: e.createdAt } };
        break;
      }
      case "question_asked":
        questions.set(e.payload.questionId, out.length);
        out.push({
          kind: "question",
          key,
          item: {
            questionId: e.payload.questionId,
            callId: e.payload.callId,
            form: e.payload.form,
            expiresAt: e.payload.expiresAt,
            answered: null,
          },
        });
        break;
      case "question_answered": {
        const i = questions.get(e.payload.questionId);
        const prev = i === undefined ? undefined : out[i];
        if (i !== undefined && prev?.kind === "question")
          out[i] = { ...prev, item: { ...prev.item, answered: e.payload } };
        break;
      }
      case "connection_required":
        out.push({
          kind: "connect",
          key,
          item: {
            callId: e.payload.callId,
            connectorId: e.payload.appId,
            connectorName: e.payload.appName,
            closed: e.runId !== null && closedRuns.has(e.runId),
          },
        });
        break;
      case "usage":
        if (e.payload.purpose === "compaction") {
          const p = e.payload;
          compactionUsage = Math.max(
            0,
            p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens - p.outputTokens,
          );
        }
        break;
      case "compaction_summary":
        out.push({
          kind: "divider",
          key,
          divider: "compacted",
          summary: e.payload.text,
          savedTokens: compactionUsage,
        });
        compactionUsage = null;
        break;
      case "run_aborted":
        out.push({
          kind: "divider",
          key,
          divider: "stopped",
          byAccountId: e.payload.byAccountId,
          at: e.createdAt,
        });
        break;
      case "run_failed": {
        const code = e.payload.error.code;
        if (code === "run.hook_denied") {
          const d = e.runId === null ? undefined : modelDenials.get(e.runId);
          out.push({
            kind: "divider",
            key,
            divider: "hook-denied",
            plugin: d?.plugin ?? null,
            reason: d?.reason ?? null,
            at: e.createdAt,
          });
          break;
        }
        out.push({
          kind: "divider",
          key,
          divider: "failed",
          code,
          message: code === "storage.unavailable" ? e.payload.error.message : "",
          at: e.createdAt,
          retry: lastUser,
          retried: false,
        });
        if (lastUser !== null) failedBySeq.set(lastUser.seq, out.length - 1);
        break;
      }
      default:
        break;
    }
  }

  // A plain message not sent to the model yet, before a fork whose sub-agent is working: the
  // fork's run took it in and answers it with the report (spec §17, batch 4 review m4).
  for (const u of plainUsers) {
    if (u.seq <= absorbed) continue;
    for (const [seq, f] of forks) {
      if (seq <= u.seq) continue;
      if (f.dispatched && !f.reported) u.waitsFor = f.label;
      break;
    }
  }

  // Calls of a run that ended without a result were never run.
  for (const c of calls.values()) {
    if (!c.done && c.runId !== null && closedRuns.has(c.runId)) {
      if (c.tool.row.status !== "failed") c.tool.row.status = "cancelled";
    }
  }
  for (const a of agentCalls.values()) {
    if (a.sub.row.status === "queued" && a.runId !== null && closedRuns.has(a.runId))
      a.sub.row.status = "aborted";
  }
  // What the log does not say yet: live calls, and a child waiting or queued again.
  for (const [id, s] of subagentRows) {
    if (s.finished) continue;
    const row = s.sub.row;
    const calls = live.progress?.[id]?.toolCalls;
    if (calls !== undefined && calls > row.toolCalls) row.toolCalls = calls;
    const v = live.views?.get(id);
    if (v === undefined) continue;
    if (v.status === "waiting") {
      row.status = "waiting";
      row.waiting =
        v.pendingApprovalIds.length > 0
          ? "approval"
          : v.pendingQuestionIds.length > 0
            ? "input"
            : "connect";
    } else if (v.status === "running" || v.status === "queued") {
      row.status = v.status;
      delete row.waiting;
    }
  }

  if (groupFiles.size === 0 && groupCards.size === 0) return { entries: out, modelOf };
  const withExtras: TimelineEntry[] = [];
  for (const entry of out) {
    withExtras.push(entry);
    if (entry.kind !== "tools") continue;
    const files = groupFiles.get(entry.key);
    if (files) withExtras.push({ kind: "files", key: `${entry.key}:files`, files });
    for (const card of groupCards.get(entry.key) ?? []) withExtras.push(card);
  }
  return { entries: withExtras, modelOf };
}

/** Turns, elapsed time and the running state for the status bar. */
export interface RunStats {
  /** `run_started` count. */
  turns: number;
  /** Start of the current or last run (ms), or null. */
  startedAt: number | null;
  /** End of the last run (ms); null while one is active. */
  endedAt: number | null;
  /** How the last run ended (null while active or before any run). */
  last: "finished" | "failed" | "aborted" | null;
}

export function runStats(events: readonly ConversationEvent[]): RunStats {
  let turns = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let last: RunStats["last"] = null;
  let active: string | null = null;
  for (const e of events) {
    if (e.type === "run_started") {
      // A resumed run writes no second run_started; a new runId is a new turn.
      if (e.runId !== active) turns += 1;
      active = e.runId;
      startedAt = Date.parse(e.createdAt);
      endedAt = null;
      last = null;
    } else if (TERMINAL.has(e.type) && e.runId !== null && e.runId === active) {
      endedAt = Date.parse(e.createdAt);
      last =
        e.type === "run_finished" ? "finished" : e.type === "run_failed" ? "failed" : "aborted";
      active = null;
    }
  }
  return { turns, startedAt, endedAt, last };
}

/** The tool keys the timeline names (for `GET …/tools?keys=`), a sub-agent's waits' included. */
export function toolKeysOf(events: readonly ConversationEvent[]): string[] {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type === "subagent_waiting") keys.add(e.payload.toolKey);
    if (e.type !== "assistant_message") continue;
    for (const b of e.payload.content) if (b.type === "tool_call") keys.add(b.name);
  }
  return [...keys];
}

/** The latest model the conversation used: the last model_call, else the last run_started. */
export function latestModel(events: readonly ConversationEvent[]): ModelRef | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ConversationEvent;
    if (e.type === "model_call") return { provider: e.payload.provider, model: e.payload.model };
    if (e.type === "run_started") return e.payload.model;
  }
  return null;
}

type Usage = Extract<ConversationEvent, { type: "usage" }>["payload"];

/**
 * The context the agent works with: the latest step call's usage (no purpose). Compaction measures
 * the old history and a title call a short excerpt, so neither counts.
 */
export function latestUsage(events: readonly ConversationEvent[]): Usage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ConversationEvent;
    if (e.type === "usage" && e.payload.purpose === undefined) return e.payload;
  }
  return null;
}

/** Tokens in the context of a usage: input (cached or not) plus output. */
export const usedTokens = (u: Usage): number =>
  u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
