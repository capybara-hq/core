import {
  type DiffData,
  type ImageRatio,
  isImageRatio,
  isInlineImageType,
  type SubagentFinishStatus,
  type SubagentRowData,
  type SubagentWaitKind,
  subagentStatusOfFinish,
  subagentWaitKind,
  type ToolRowData,
} from "@capybara-hq/design";
import type {
  ApprovalPolicy,
  Approver,
  BackgroundTaskStatus,
  CommandAsk,
  ContentBlock,
  ConversationEvent,
  HandoffTarget,
  InputForm,
  MessageAttachment,
  ModelRef,
  ReviewRecord,
  ToolInfo,
  ToolResultImage,
} from "./conversations";
import type { OrgRole } from "./members";
import { parsePartialJson } from "./partial-json";
import type { PersonRef } from "./people";
import { PersonWaits } from "./person-waits";
import { type DraftBase, type DraftTool, isSettledBase } from "./run-drafts";
import { skillChipLabel } from "./skills";
import { inputValue, loggedLiveView, streamingView } from "./streaming-tool-view";
import { toolLabel, toolLabelOfKey, toolLabelText } from "./tool-label";

/**
 * The conversation timeline (UI refresh B, spec §5.5–§5.8): the one pure builder that turns the
 * event log (plus the streaming drafts) into what the thread renders. Pages never group tool calls
 * themselves.
 *
 * - Consecutive tool calls form one `tools` entry; prose, thinking, a user message, a
 *   human-in-the-loop item or a divider ends the group. Prose is never folded into a group.
 * - Prose is `narration` when its step also calls a tool, else an answer (process blocks spec
 *   §1.1); a card carries its `placement` (`output` when the log has none). `groupProcess`
 *   (`lib/process.ts`) folds a run's process into blocks after this builder.
 * - A call's `artifact_created` files and its inline card (`tool_result.card`) land right after the
 *   group that holds the call (files first), then its network facts (`network_blocked` hosts of the
 *   `org` and `address` layers; `device`-layer hosts are asked about in an approval instead), then
 *   a `device_code` card (`gh auth login --web`). Inline images of a group stand in call order
 *   (not log order); while a `GenerateImage` call runs (started, not waiting for a person), its
 *   images still missing are `generating` slots that the images replace in place.
 * - `hook_denied` with a `callId` marks that row as blocked by the extension.
 * - Every run that ended (`run_finished`, `run_failed`, `run_aborted`) becomes a `run` entry at its
 *   terminal event: its model (the last `model_call`, else `run_started`), duration and tokens (its
 *   `usage` events) and how it ended (spec §6.16.23); a run still going has none. A `user_message`
 *   with `retryOf` folds into the failed run of the message it repeats ("Retried") instead of a
 *   second bubble. `compaction_summary`, `model_switched { reason: "unavailable" }` (the fallback)
 *   and a person's own `model_switched` (`switched`) become dividers. A manual compact run
 *   (`run_started.trigger: "compact"`) draws no run row: its outcome is one divider, the summary,
 *   `compaction_skipped` (nothing to compact), its `compaction_failed` or its run's failure, or a
 *   stop (an automatic compaction's failure stays silent; maintainer decision 2026-11-28).
 * - Logs written before UI refresh B (no `description`, `view`, title or card) still render: rows
 *   fall back to the tool key and the first string argument, failures to `isError`.
 * - Sub-agents (phase C, Task 21): consecutive `agent` calls form one `subagents` entry, its rows
 *   from `subagent_dispatched` / `subagent_finished` (plus live progress and the sub-agents list),
 *   the call's result as the in-place summary; a call refused before any dispatch is a failed row.
 *   `subagent_waiting` puts the child's approval, question or connection into the parent; a child's
 *   task message (`user_message.dispatch`) is a `task` entry.
 * - Background sub-agents (agent map spec §5, §9.4): an unfinished row names the child's current
 *   tool (`subagent_progress.lastToolKey`); a parent's `SendMessage` in the child's log
 *   (`dispatch.kind: "message"`) is a user bubble with its `sender`; a `subagent_delivery` (a
 *   report, a note or the child's end) is a compact `delivery` entry in the parent (a run that
 *   handed back a report logs no finished delivery when it completes, so its end entry comes from
 *   `subagent_finished`, once per run with an older log's delivery; a completion right after its
 *   own report, nothing drawn between, merges into that report's line); `SendMessage`
 *   and `SubagentHandback` are ordinary tool rows. A child that runs again after an end stays on
 *   its `Agent` call's row: a restart (`subagent_dispatched` carrying the `SendMessage` call's id),
 *   a wake (no dispatch: the list's run started after the last end, or a later run's
 *   `subagent_finished` / `subagent_waiting`). An ended row shows the run's time and tokens.
 * - Skill invocations (phase D): a person's `user_message` with `skill` is a bubble with the skill
 *   chip, the arguments as typed and, inline, the rendered instructions (`content[0]`; a fork's
 *   `content[0]` is the lead, and its instructions are the child's task). A fork's dispatch
 *   (`subagent_dispatched.invokedSeq`, no `agent` call) is a sub-agent row at its log position,
 *   its `skill_fork_result` a `skill-report` entry. A plain message that a later fork's run took
 *   in, not yet sent to the model while that sub-agent works, says it waits for it (`waitsFor`).
 *   A sub-agent's task message carries the `skill` record too and stays a `task`.
 * - Background Bash (background Bash spec §5): a `Bash` call with `run_in_background: true` is a
 *   row with `background` (its task id from the result), `TaskOutput` / `TaskStop` rows name the
 *   task's description, and `background_task_finished` is a `background` notice entry.
 * - Interjections (run input spec D4): a person's message logged while a run is going stands where
 *   the model took it in, not at its `seq`: right before the first `model_call` whose
 *   `request.absorbedUpToSeq` covers it, so
 *   it sits below the step that was streaming when it was sent. Not taken in yet while the run goes
 *   on, it is `pending` and stands after the streaming drafts; a run that ends without taking it in
 *   leaves it after the run's row, where it starts the next run. A fork invocation stands before its
 *   dispatch.
 */

export type ApprovalDecision = Extract<ConversationEvent, { type: "approval_decided" }>["payload"];
export type QuestionOutcome = Extract<ConversationEvent, { type: "question_answered" }>["payload"];

/** A file uploaded with a user message (an image / document / file reference block). */
export interface MessageFile {
  attachmentId: string;
  kind: "image" | "document" | "file";
  mediaType: string;
  name: string;
  /** Bytes, when the block carries it (display metadata for the chip; never sent to the model). */
  size?: number;
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
  progress?: Readonly<Record<string, { toolCalls: number; lastToolKey?: string }>>;
  views?: ReadonlyMap<
    string,
    {
      status: string;
      /** The latest run's start: a run after the log's last finish (a wake) reopens the row. */
      startedAt?: string;
      pendingApprovalIds: string[];
      pendingQuestionIds: string[];
      watchedQuestionIds?: string[];
    }
  >;
  /**
   * Who a waiting call waits for, as its row words it ("等待 张三 批准"): a name or a role, or
   * undefined when it is the viewer (or unknown). Absent = every wait reads "你".
   */
  whoWaits?: (w: Waiter) => string | undefined;
  /**
   * The name of an agent of the tree (a parent message's sender, a nested agent's wait), when
   * known (the agent tree).
   */
  agentName?: (conversationId: string) => string | undefined;
  /**
   * An agent's own status per the agent tree, when known: a nested agent's wait holds its
   * root-level row waiting only while the tree does not say it went on.
   */
  agentStatus?: (conversationId: string) => string | undefined;
  /**
   * The background tasks list (`GET …/background-tasks`) by task id, when read: settles a launch
   * whose start was not confirmed (a reconciling row) once the kernel confirmed it (`running`
   * without `starting`) or ended it, before or without its finish in the log.
   */
  backgroundTasks?: ReadonlyMap<string, BackgroundTaskLive>;
}

/** What the timeline reads of a background task from the list. */
export interface BackgroundTaskLive {
  status: BackgroundTaskStatus;
  /** The start was sent but not confirmed yet (the kernel reconciles it). */
  starting?: boolean;
  exitCode: number | null;
  lostReason: string | null;
}

/**
 * Whether a background task ended without being known to have run: its launch was given up,
 * abandoned, revoked or refused (the kernel's `launch_unknown`, `launch_abandoned`,
 * `launch_revoked`, `launch refused: …` reasons), not a task that ran and was lost later
 * (`supervision_lost`, `sandbox_recreated`).
 */
const neverRan = (t: {
  status: BackgroundTaskStatus;
  lostReason?: string | null | undefined;
}): boolean =>
  (t.status === "lost" || t.status === "failed") && (t.lostReason ?? "").startsWith("launch");

/** A list status of a run that is still going. */
const isActiveView = (s: string) => s === "queued" || s === "running" || s === "waiting";

/** How a sub-agent's run ended, as its delivery row words it. */
export type DeliveryStatus = "completed" | "limit" | "failed" | "aborted";

/** Who has to act on a wait: a member (an approval's assignee, a run's starter) or a role. */
export type Waiter = { kind: "account"; accountId: string } | { kind: "role"; role: OrgRole };

/** `{ approver }` for an entry when the event names one, else nothing. */
const approverField = (a: Approver): { approver?: Waiter } => {
  const w = approverOf(a);
  return w === undefined ? {} : { approver: w };
};

/** An approval's {@link Waiter} from its event; undefined in logs older than the field. */
export function approverOf(a: Approver): Waiter | undefined {
  if (a.requestedFor) return { kind: "account", accountId: a.requestedFor };
  if (a.approverRole) return { kind: "role", role: a.approverRole };
  return undefined;
}

/** A tool row plus what the container needs to act on it. */
export interface TimelineTool {
  row: ToolRowData;
  callId: string;
  toolKey: string;
  input: unknown;
  /** The archive of a cut output (`ReadToolOutput`), or null. */
  outputId: string | null;
  /** A read's line range; the thread shows it as the row's extra through i18n (m10). */
  lines?: { from: number; to: number };
  /** The command review's decision on the call (auto mode spec §5.4), when it was reviewed. */
  review?: ReviewRecord;
  /**
   * A background `Bash` call (`run_in_background: true`): the thread labels it "In background"
   * through i18n, as the row's `extra` (it replaces any other extra, e.g. an extension's display
   * summary; a line range still wins), and links its task (`#bg-<taskId>`, the row's `link`) once
   * the result named it.
   */
  background?: { taskId: string | null };
  /** The images stored for the call (`tool_result.media`): the thread shows them on the row. */
  images?: ToolResultImage[];
  /**
   * The model step that made the call: a `tools` entry runs on across steps, and a process block
   * draws each step's calls (one, or a parallel burst) as one rail step.
   */
  step?: StepRef;
}

export interface ApprovalItem {
  approvalId: string;
  callId: string;
  toolKey: string;
  input: unknown;
  expiresAt: string;
  policy?: ApprovalPolicy;
  /** Who may decide it (absent when the event names neither an account nor a role). */
  approver?: Waiter;
  /** A network ask (network ask spec §6.5): the device-layer hosts asked for. */
  network?: { hosts: string[] };
  /** A command review ask (auto mode spec §5.4): what is held and why. */
  command?: CommandAsk;
  /** A secure input request: what the values are for and the field paths (never a value). */
  secureInput?: { target: { zh: string; en: string }; fields: string[] };
  decided: ApprovalDecision | null;
  decidedAt: string | null;
}

export interface QuestionItem {
  questionId: string;
  callId: string;
  form: InputForm;
  expiresAt: string;
  /** A plugin tool's `InputRequired.open`: the panel the question names (the card's action). */
  open?: { plugin: string; contribution: string; item?: string };
  /** A watched wait (the agent waits for a condition): drawn as a wait card. */
  watch?: true;
  /** `byPerson`: the answerer as a question read names them (a sub-agent's wait), when known. */
  answered: (QuestionOutcome & { byPerson?: PersonRef | null }) | null;
}

export interface ConnectItem {
  callId: string;
  connectorId: string;
  connectorName: string;
  /** The run already ended (a card in the history no longer offers Connect). */
  closed: boolean;
}

export type DividerData =
  | { divider: "compacted"; summary: string; savedTokens: number | null }
  /** A manual compaction found nothing to summarize (`compaction_skipped`). */
  | { divider: "compact-skipped" }
  /** A manual compaction failed: its `compaction_failed` reason, or its run's failure. */
  | { divider: "compact-failed"; reason: string }
  /** A manual compact run was stopped. */
  | { divider: "compact-stopped" }
  | { divider: "fallback"; from: ModelRef | null; to: ModelRef | null }
  /** A person switched the conversation's model or effort (`model_switched`, reason `user`). */
  | { divider: "switched"; model: ModelRef | null; effort: string | null };

/** A run's tokens: every `usage` of the run (its step calls and compaction). */
export interface RunTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + cacheRead + cacheWrite + output. */
  total: number;
}

/** A limit a finished run stopped at (`run_finished.reason` other than `completed`). */
export type RunLimit = "max_steps" | "max_duration" | "budget" | "max_output";

const RUN_LIMITS: ReadonlySet<string> = new Set<RunLimit>([
  "max_steps",
  "max_duration",
  "budget",
  "max_output",
]);

/** How a run ended (its run row, spec §6.16.23). */
export type RunEnd =
  | {
      status: "ok";
      /**
       * The run ended at a limit, not because the agent was done (`run_finished.reason`): the
       * step or time limit, the token budget, or the output token limit (issue #951).
       */
      limit?: RunLimit;
    }
  | { status: "stopped"; byAccountId: string | null }
  | {
      status: "failed";
      code: string;
      /** The kernel's raw message (English; the row keeps it behind 原始错误). */
      message: string;
      /** A `model.request` denial (`run.hook_denied`): the extension and its reason. */
      hook: { plugin: string | null; reason: string | null } | null;
      /** The last user message before the failure (what Retry repeats), or null. */
      retry: RetryMessage | null;
      /** A later message retried it. */
      retried: boolean;
    };

/** A run that ended, from the log alone (`run_started`, `model_call`, `usage`, the terminal). */
export type RunData = {
  runId: string | null;
  /** The run's last model call, else the model it started with; null when the log has neither. */
  model: ModelRef | null;
  /** A manual compact run (`run_started.trigger: "compact"`): its row names itself. */
  compact?: boolean;
  /**
   * The run's working time: from `run_started` to the terminal event without its waits for a
   * person (an approval or a question, until answered), the same derivation as the status bar's
   * elapsed time ({@link runStats}), so the two agree; null without a start.
   */
  durationMs: number | null;
  /** Null when the run reported no usage. */
  tokens: RunTokens | null;
  /** When it ended. */
  at: string;
} & RunEnd;

export type FailedRun = Extract<TimelineEntry, { kind: "run"; status: "failed" }>;

/** What Retry repeats: the text (an invocation's arguments), files and the skill invoked. */
export interface RetryMessage {
  seq: number;
  text: string;
  files: MessageFile[];
  /** A skill invocation: the name to invoke again (`<plugin>:<name>` for a plugin's skill). */
  skill?: string;
}

/**
 * The model step an entry came from (its run and step), the same for a streaming draft and the
 * step once it lands in the log: `groupProcess` keys a process block by it, so the block keeps its
 * key while its first step goes from draft to log.
 */
export interface StepRef {
  runId: string;
  step: number;
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
      /** The person who wrote it (a person's message; absent for an agent's dispatch). */
      authorAccountId?: string;
      /** A plain message a later fork's run took in: answered after that sub-agent ("/review"). */
      waitsFor?: string;
      /**
       * Sent while a run is going and not taken in yet (spec D4: 待处理): the entry stands after the
       * streaming drafts, at the bottom, until a model call takes it in or the run ends.
       */
      pending?: true;
      /**
       * Sent by another agent, not a person: a parent's `SendMessage` in a sub-agent's log (agent
       * map spec §9.4), its conversation id and name when known.
       */
      sender?: { id: string; name?: string };
    }
  | {
      /** The report of the sub-agent that ran a person's fork invocation (phase D). */
      kind: "skill-report";
      key: string;
      text: string;
    }
  | {
      kind: "prose";
      key: string;
      text: string;
      streaming: boolean;
      step?: StepRef;
      /**
       * Narration, not an answer (process blocks spec §1.1): the step's content also has a
       * `tool_call` block (a draft: a streamed call in {@link TimelineDraft.tools}). `groupProcess`
       * folds it into the run's process block.
       */
      narration: boolean;
    }
  | {
      kind: "thinking";
      key: string;
      text: string;
      seconds: number | null;
      live: boolean;
      /** The model that thought (decides whether thinking shows), or null. */
      model: ModelRef | null;
      step?: StepRef;
    }
  /** `step`: the step of the group's first call. */
  | { kind: "tools"; key: string; rows: TimelineTool[]; step?: StepRef }
  | { kind: "subagents"; key: string; rows: TimelineSubagent[]; step?: StepRef }
  | {
      /**
       * A sub-agent waits for a person: its approval, question or connection, in the root (at any
       * depth, agent map spec §7).
       */
      kind: "subagent-wait";
      key: string;
      subagent: { id: string; name: string };
      /** Not a child of this conversation but deeper (its record is opened in the agent map). */
      deep?: true;
      wait: SubagentWaitKind;
      approvalId?: string;
      questionId?: string;
      /** Who may decide the sub-agent's approval (absent when the event names nobody). */
      approver?: Waiter;
      toolKey: string;
      expiresAt?: string;
      /** The child's question is a watched wait. */
      watch?: true;
      /**
       * The wait is over: a later wait of the same sub-agent replaced it, or its row no longer
       * waits (decided, answered, connected, finished). The process block folds it into its rail.
       */
      ended?: true;
    }
  | {
      kind: "task";
      key: string;
      seq: number;
      text: string;
      /**
       * The template's skills the kernel wrote after the task (`skill.template`, or
       * `templateSkillNotice` for one it could not read): each skill's chip ("/alpha-notes") and
       * its rendered instructions (`content[0]`, the notice for an unreadable one).
       */
      skills?: { label: string; instructions: string }[];
    }
  | {
      /** A sub-agent's delivery to its parent (`subagent_delivery`, agent map spec §4.5). */
      kind: "delivery";
      key: string;
      subagentId: string;
      /** The sub-agent's task description. */
      name: string;
      /**
       * `report-finished`: a report directly followed by its run's completion, with nothing drawn
       * between them, merged into one line (its text the report).
       */
      delivery: "report" | "note" | "finished" | "report-finished";
      /** `finished` only. */
      status?: DeliveryStatus;
      /** The report, the note, or a finish's final reply or error ("" when it handed back). */
      text: string;
    }
  | { kind: "approval"; key: string; item: ApprovalItem }
  | { kind: "question"; key: string; item: QuestionItem }
  | { kind: "connect"; key: string; item: ConnectItem }
  | {
      kind: "card";
      key: string;
      plugin: string;
      view: string;
      callId: string;
      cardKey?: string;
      /**
       * Where the card stands (process blocks spec §5): `output` after the block (a log without
       * a placement reads as `output`), `pinned` under the block head (latest only), `process` in
       * the rail under its call.
       */
      placement: "output" | "pinned" | "process";
      /**
       * A pinned card's state as the tool recorded it (its view's badge, "3/5"): the finished
       * process head shows it without reading the view.
       */
      badge?: string;
      /** A pinned card's Markdown (`ToolResult.card.text`); the rail's sections read a task list in it. */
      text?: string;
    }
  | {
      /**
       * Network hosts a command was refused that no card can lift (`network_blocked`, layers
       * `org` and `address`), under the group that holds the command.
       */
      kind: "network-facts";
      key: string;
      callId: string;
      hosts: { host: string; layer: "org" | "address" }[];
    }
  | {
      /**
       * A `gh auth login --web` device-code prompt (`device_code`, auto mode spec §6): the URL to
       * open and the one-time code, under the group that holds the command.
       */
      kind: "device-code";
      key: string;
      callId: string;
      url: string;
      code: string;
    }
  | {
      /**
       * A `Platform` operation's link card (`tool_result.view` kind `handoff`, platform web parity
       * spec §6): the title in the viewer's language and the one button's target, under the group
       * that holds the call.
       */
      kind: "handoff";
      key: string;
      callId: string;
      title: string;
      target: HandoffTarget;
    }
  | {
      /**
       * A `Platform` operation's result the run's person reads once (`tool_result.view` kind
       * `reveal`), by call, under the group that holds the call. `starterAccountId` is the run's
       * person when the log names them.
       */
      kind: "reveal";
      key: string;
      callId: string;
      runId: string;
      reveal: "initial_password" | "invitation_link";
      starterAccountId?: string;
    }
  | {
      /** A group's files: inline images (and generating placeholders) in call order, then the rest. */
      kind: "files";
      key: string;
      images: ImageSlot[];
      others: FileRef[];
    }
  | ({ kind: "divider"; key: string } & DividerData)
  | {
      /** A background task ended (`background_task_finished`): a one-line notice that opens it. */
      kind: "background";
      key: string;
      taskId: string;
      description: string;
      status: Extract<ConversationEvent, { type: "background_task_finished" }>["payload"]["status"];
      exitCode: number | null;
    }
  | ({ kind: "run"; key: string } & RunData);

/**
 * One inline image place: a delivered image, or a placeholder for an image a running
 * `GenerateImage` call has not produced yet (`index` 0-based within the call, `count` requested).
 */
export type ImageSlot =
  | { kind: "image"; file: FileRef; ratio: ImageRatio | null }
  | {
      kind: "generating";
      key: string;
      callId: string;
      ratio: ImageRatio | null;
      index: number;
      count: number;
    };

/** A streaming draft (`event: delta`), not in the log yet. */
export interface TimelineDraft {
  runId: string;
  step: number;
  text: string;
  thinking: string;
  /**
   * The step's streamed tool calls (display only; rows are built from them by the timeline). A
   * step with one already started a tool call: its text is narration (process blocks spec §1.1),
   * so it moves into the process block before the step lands in the log.
   */
  tools: readonly DraftTool[];
}

const TERMINAL = new Set<ConversationEvent["type"]>(["run_finished", "run_failed", "run_aborted"]);
/** The builtin tool that dispatches sub-agents. */
export const AGENT_TOOL = "Agent";
/** The builtin image tool: while it runs, its images show as placeholders. */
export const GENERATE_IMAGE_TOOL = "GenerateImage";
/** The most images one call may ask for (the kernel's `models.imageMaxPerCall` maximum). */
const MAX_IMAGES_PER_CALL = 10;
/** How many images a `GenerateImage` call asked for: `n` when an integer 1–10, else 1. */
function wantedImages(input: unknown): number {
  const n = asRecord(input).n;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_IMAGES_PER_CALL ? n : 1;
}
/** The builtin question tool: its row reads "已提问 <header>" (design kind `question`, §6.16.9). */
export const QUESTION_TOOL = "AskUserQuestion";
/** The builtin shell tool; `run_in_background: true` makes a background task. */
const BASH_TOOL = "Bash";
/** The builtins that name a background task by `task_id`: their rows show its description. */
const TASK_TOOLS = new Set(["TaskOutput", "TaskStop"]);
/** A background launch's result starts with the task's id (kernel `background/launch.ts`). */
const STARTED_TASK = /^Started background task (bt_[a-z0-9]+) /;

/** The question row's preview: the first question's header, else its text, else the title. */
function questionPreview(input: unknown, info: ToolInfo | undefined): string | undefined {
  const questions = asRecord(input).questions;
  const first = Array.isArray(questions) ? asRecord(questions[0]) : {};
  for (const k of ["header", "question"]) {
    const v = first[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return info?.title ?? undefined;
}
const stepKey = (runId: string, step: number) => `${runId}:${step}`;
const callKey = (runId: string | null, callId: string) => `${runId ?? ""}\u0000${callId}`;
/** A tool group's key: by its first call, so a streaming group and the logged one match (D8). */
const toolGroupKey = (firstCallKey: string) => `g${firstCallKey}`;
/** A row id that is a call key (an `agent` call never dispatched), not a sub-agent id. */
export const isCallKey = (id: string) => id.includes("\u0000");

/**
 * What a compaction divider shows as saved: the summary event's estimate, or null when nothing was
 * saved (0): "saved 0 tokens" is no news, the divider stays plain.
 */
const savedTokensOf = (saved: number): number | null => (saved === 0 ? null : saved);

const joinText = (blocks: { type: string; text?: string }[], type: "text" | "thinking") =>
  blocks
    .filter((b) => b.type === type)
    .map((b) => b.text ?? "")
    .join("");

/** user_message image / document / file reference blocks (`base64` never reaches the log). */
export function messageFiles(content: ContentBlock[]): MessageFile[] {
  return content.flatMap((b): MessageFile[] =>
    (b.type === "image" || b.type === "document" || b.type === "file") && b.source.kind === "ref"
      ? [
          {
            attachmentId: b.source.attachmentId,
            kind: b.type,
            mediaType: b.mediaType,
            name: b.name ?? b.source.attachmentId,
            ...(b.size !== undefined ? { size: b.size } : {}),
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

/** An input value as text, bounded (`INPUT_VALUE_MAX_CHARS`: a value can be 512 KB). */
const valueText = (v: unknown): string => inputValue(v);

/**
 * The key argument: the tool's first declared key argument, else the first string input. A
 * streaming call whose tool declares its key arguments (or a path / command in its input view)
 * never falls back: a model often streams `content` before `file_path`, and the content is no
 * key argument. It shows none until a declared one has parsed.
 */
function keyArgOf(
  input: unknown,
  info: ToolInfo | undefined,
  streaming = false,
): string | undefined {
  const rec = asRecord(input);
  for (const k of info?.keyArgs ?? []) {
    if (Object.hasOwn(rec, k) && rec[k] !== undefined) return valueText(rec[k]);
  }
  if (streaming) {
    const v = info?.inputView;
    const declared = (info?.keyArgs.length ?? 0) > 0;
    const viewField =
      v?.kind === "file_write" || v?.kind === "file_edit"
        ? v.path
        : v?.kind === "command"
          ? v.command
          : undefined;
    if (viewField !== undefined && Object.hasOwn(rec, viewField)) {
      const val = rec[viewField];
      if (val !== undefined) return valueText(val);
    }
    if (declared || viewField !== undefined) return undefined;
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
  /** The tool info and locale the log's rows were built with (a draft's streaming rows use them). */
  info: ReadonlyMap<string, ToolInfo>;
  locale: "zh" | "en";
}

const isPending = (e: TimelineEntry | undefined): boolean =>
  e?.kind === "user" && e.pending === true;

/** A streaming call's row as last built: rebuilt only when its draft, tool info or locale change. */
interface StreamingRowMemo {
  at: StepRef;
  info: ToolInfo | undefined;
  locale: "zh" | "en";
  tool: TimelineTool;
}
/**
 * By draft tool object: the reducer makes a new one only when the call changed, and it applies a
 * frame's deltas at once, so a call's input is parsed at most once per animation frame (spec D5),
 * and not at all while it does not grow.
 */
const streamingRows = new WeakMap<DraftTool, StreamingRowMemo>();

/**
 * By call key: the base a streaming `Write` was diffed against, so the logged call keeps diffing
 * its complete input against it until the result (spec D8, ruling R13) once the draft (which held
 * the base) is gone. Bounded (oldest first out); client state of this page only.
 */
const lastBases = new Map<string, DraftBase>();
const LAST_BASES_MAX = 64;

/** Keeps a streaming `Write`'s base for its logged row: only an exact or a confirmed one. */
function rememberBase(key: string, base: DraftBase): void {
  if (lastBases.get(key) === base) return;
  lastBases.delete(key);
  lastBases.set(key, base);
  if (lastBases.size > LAST_BASES_MAX) lastBases.delete(lastBases.keys().next().value as string);
}

/** A streamed call's row (spec §6.4), keyed like the logged call that replaces it (D8). */
function streamingTool(
  at: StepRef,
  t: DraftTool,
  info: ReadonlyMap<string, ToolInfo>,
  locale: "zh" | "en",
): TimelineTool {
  const ti = info.get(t.name);
  const memo = streamingRows.get(t);
  if (
    memo &&
    memo.at.runId === at.runId &&
    memo.at.step === at.step &&
    memo.info === ti &&
    memo.locale === locale
  )
    return memo.tool;
  const parsed = parsePartialJson(t.input);
  const input = parsed.value ?? {};
  const view = streamingView(t, parsed, ti?.inputView ?? null);
  const question = t.name === QUESTION_TOOL;
  const kind: ToolRowData["kind"] = question ? "question" : (ti?.kind ?? "tool");
  // the row shows a description instead of the key argument only for a command kind
  const keyArg =
    (kind !== "command" ? view.description : undefined) ??
    view.keyArg ??
    (question ? questionPreview(input, ti) : keyArgOf(input, ti, true));
  const label = ti ? toolLabel(ti, locale) : toolLabelOfKey(t.name);
  const row: ToolRowData = {
    id: callKey(at.runId, t.id),
    kind,
    name: label.name,
    status: "streaming",
    progress: view.progress,
    ...(label.tool !== undefined ? { tool: label.tool } : {}),
    ...(label.tooltip !== undefined ? { tooltip: label.tooltip } : {}),
    ...(keyArg !== undefined && keyArg !== "" ? { keyArg } : {}),
    // the key argument is the view's guessed path (a guessed base without a verdict yet)
    ...(view.keyArgGuess === true && keyArg === view.keyArg ? { keyArgGuess: true } : {}),
    ...(view.description !== undefined ? { description: view.description } : {}),
    ...(view.added !== undefined ? { added: view.added } : {}),
    ...(view.removed !== undefined ? { removed: view.removed } : {}),
    ...(view.detail !== undefined ? { detail: view.detail } : {}),
  };
  // the step too: a process block draws a step's calls as one rail step, as it will once logged
  const tool: TimelineTool = {
    row,
    callId: t.id,
    toolKey: t.name,
    input,
    outputId: null,
    step: at,
  };
  streamingRows.set(t, { at, info: ti, locale, tool });
  if (isSettledBase(t.base)) rememberBase(row.id, t.base);
  return tool;
}

/** The entries the final pass of {@link buildEventTimeline} places after a group, by call. */
const GROUP_EXTRAS = new Set<TimelineEntry["kind"]>([
  "files",
  "card",
  "network-facts",
  "device-code",
  "handoff",
  "reveal",
]);

/**
 * The index of the tools group a prose-less step's calls join once logged, or -1: the last entry,
 * or the last group followed only by the extras the final pass put after it (its files, cards,
 * network facts, device codes, handoffs, reveals). An extra placed on its own (no group of its
 * call) ends the group in the log too. It reads the timeline before `groupProcess`, where a card of
 * any placement still follows its group, so the joined rows land in the process block's rail step
 * of the logged calls (same group key, same step).
 */
function joinedGroupAt(out: readonly TimelineEntry[]): number {
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i] as TimelineEntry;
    if (e.kind === "tools") {
      const calls = new Set(e.rows.map((r) => r.callId));
      for (let j = i + 1; j < out.length; j++) {
        const x = out[j] as TimelineEntry;
        const of =
          x.kind === "files" ? x.key === `${e.key}:files` : "callId" in x && calls.has(x.callId);
        if (!of) return -1;
      }
      return i;
    }
    if (!GROUP_EXTRAS.has(e.kind)) return -1;
  }
  return -1;
}

/**
 * The streaming drafts after the log's entries, before the pending interjections (spec D4: a
 * message the streaming step never saw stands below it). Cheap: the page memoizes
 * {@link buildEventTimeline} over the events and adds the drafts on each delta frame, so a token
 * does not rebuild the timeline (final review I3); the log's entry objects stay the same.
 *
 * A draft's streamed tool calls (streaming tool input spec §6.2) are `streaming` rows after its
 * prose, grouped as the logged calls will be: one group, joining the log's last group when the
 * draft wrote no prose, under the key the logged group gets, and each row with its call's id, so
 * the logged step replaces them in place (D8). A streamed call the logged message lacks goes with
 * the draft.
 */
export function withDrafts(base: EventTimeline, drafts: readonly TimelineDraft[]): TimelineEntry[] {
  // the pending interjections are the log's last entries (buildEventTimeline puts them there)
  let tail = base.entries.length;
  while (tail > 0 && isPending(base.entries[tail - 1])) tail--;
  const out = base.entries.slice(0, tail);
  let added = false;
  for (const d of drafts) {
    if (d.text === "" && d.thinking === "" && d.tools.length === 0) continue;
    added = true;
    const calling = d.tools.length > 0;
    if (d.thinking !== "") {
      out.push({
        kind: "thinking",
        key: `d${d.runId}:${d.step}:thinking`,
        text: d.thinking,
        seconds: null,
        live: d.text === "" && !calling,
        model: base.modelOf(d.runId, d.step),
        step: { runId: d.runId, step: d.step },
      });
    }
    if (d.text !== "") {
      // the text is written once the model starts a call, and is then narration
      out.push({
        kind: "prose",
        key: `d${d.runId}:${d.step}`,
        text: d.text,
        streaming: !calling,
        narration: calling,
        step: { runId: d.runId, step: d.step },
      });
    }
    if (!calling) continue;
    const step: StepRef = { runId: d.runId, step: d.step };
    const rows = d.tools.map((t) => streamingTool(step, t, base.info, base.locale));
    const at = joinedGroupAt(out);
    const group = at >= 0 ? out[at] : undefined;
    if (group?.kind === "tools") out[at] = { ...group, rows: [...group.rows, ...rows] };
    else out.push({ kind: "tools", key: toolGroupKey(rows[0]?.row.id ?? ""), rows, step });
  }
  if (!added) return base.entries;
  for (let i = tail; i < base.entries.length; i++) out.push(base.entries[i] as TimelineEntry);
  return out;
}

/**
 * The tool keys the drafts' streamed calls name, sorted (the page asks for their tool info with the
 * log's).
 */
export function streamedToolKeys(drafts: readonly TimelineDraft[]): string[] {
  const keys = new Set<string>();
  for (const d of drafts) for (const t of d.tools) if (t.name !== "") keys.add(t.name);
  return [...keys].sort();
}

/** Events of a run that are its output (what replaces the working line, spec §2.2). */
const OUTPUT = new Set<ConversationEvent["type"]>([
  "assistant_message",
  "tool_call_started",
  "approval_requested",
  "question_asked",
  "connection_required",
  "subagent_dispatched",
  "subagent_started",
]);

/** How long a message this tab sent waits for its run before the page stops expecting one. */
export const AWAIT_RUN_MS = 60_000;

/**
 * The newest user message this tab sent (`sentHere`: its `clientMessageId`s and this tab's send
 * times) that no run took up
 * yet: no run started after it, no run failed or stopped after it, and no finished run consumed
 * it. Null when there is none: the conversation is idle (or the kernel could not deliver it).
 */
export function awaitedMessage(
  events: readonly ConversationEvent[],
  sentHere: ReadonlyMap<string, number>,
): ConversationEvent | null {
  let u: ConversationEvent | null = null;
  for (const e of events) {
    if (e.type === "user_message") {
      const id = e.payload.clientMessageId;
      u = id !== undefined && sentHere.has(id) ? e : null;
    } else if (u !== null) {
      if (e.type === "run_started" || e.type === "run_failed" || e.type === "run_aborted") u = null;
      else if (e.type === "run_finished" && e.payload.consumedUpToSeq >= u.seq) u = null;
    }
  }
  return u;
}

/**
 * A message this tab sent waits for its run ({@link awaitedMessage}), unless no run is coming:
 * {@link AWAIT_RUN_MS} passed since this tab sent it without a `run_started` (a backstop: the page
 * then follows the log alone). Both times are this tab's clock (`now` and the send time in
 * `sentHere`).
 */
export function awaitingRun(
  events: readonly ConversationEvent[],
  sentHere: ReadonlyMap<string, number>,
  now: number,
): boolean {
  const u = awaitedMessage(events, sentHere);
  if (u?.type !== "user_message" || u.payload.clientMessageId === undefined) return false;
  const sentAt = sentHere.get(u.payload.clientMessageId);
  return sentAt !== undefined && now - sentAt <= AWAIT_RUN_MS;
}

/** The run in progress per the log (started, not ended), or null. */
function activeRun(events: readonly ConversationEvent[]): { runId: string; seq: number } | null {
  let run: { runId: string; seq: number } | null = null;
  for (const e of events) {
    if (e.type === "run_started" && e.runId !== null) run = { runId: e.runId, seq: e.seq };
    else if (run !== null && TERMINAL.has(e.type) && e.runId === run.runId) run = null;
  }
  return run;
}

/**
 * The composer's hint while the run in progress waits for a person (reply while a question is
 * pending, spec §11.1): `"skip"` when a question of this conversation's run is pending and
 * `viewerId` started the run (`run_started.triggerAccountId`), so a message skips it; `"hold"` when
 * it waits otherwise (approvals only, or the viewer did not start it), so a message is taken in once
 * the wait ends; null when no run waits. A sub-agent's question (`subagent_waiting`) is not this
 * run's: a root message never skips it, so it never makes this `"skip"`.
 */
export function composerWait(
  events: readonly ConversationEvent[],
  viewerId: string,
): "skip" | "hold" | null {
  let run: string | null = null;
  let starter: string | undefined;
  const waits = new PersonWaits();
  const questions = new Set<string>();
  for (const e of events) {
    if (e.type === "run_started" && e.runId !== null) {
      run = e.runId;
      starter = e.payload.triggerAccountId;
      waits.clear();
      questions.clear();
      continue;
    }
    if (run === null || e.runId !== run) continue;
    if (TERMINAL.has(e.type)) {
      run = null;
      waits.clear();
      questions.clear();
      continue;
    }
    waits.apply(e);
    if (e.type === "question_asked") questions.add(e.payload.questionId);
    else if (e.type === "question_answered") questions.delete(e.payload.questionId);
  }
  if (run === null || !waits.waiting) return null;
  return questions.size > 0 && starter !== undefined && starter === viewerId ? "skip" : "hold";
}

/**
 * Whether the working line shows (conversation send spec §2.2, review fix 1): never while the run
 * waits for a person (the card is the output); else when this view has a pending send, when the
 * run in progress has no output since it started or since its last settled tool result (and no
 * call the run logged is still without its result: pending, waiting or running), or when a message this tab sent waits for its run ({@link awaitingRun}). An
 * idle conversation, one whose message the kernel could not deliver, and a child conversation
 * that is not running show none.
 */
export function workingLineVisible(
  events: readonly ConversationEvent[],
  drafts: readonly TimelineDraft[],
  s: {
    waiting: boolean;
    pending: number;
    sentHere: ReadonlyMap<string, number>;
    now: number;
  },
): boolean {
  if (s.waiting) return false;
  if (s.pending > 0) return true;
  const run = activeRun(events);
  if (run === null) return awaitingRun(events, s.sentHere, s.now);
  if (
    drafts.some(
      (d) => d.runId === run.runId && (d.text !== "" || d.thinking !== "" || d.tools.length > 0),
    )
  )
    return false;
  const open = new Set<string>();
  let output = false;
  for (const e of events) {
    if (e.seq <= run.seq || e.runId !== run.runId) continue;
    if (e.type === "tool_result") {
      open.delete(e.payload.callId);
      output = false;
    } else if (OUTPUT.has(e.type)) {
      output = true;
      if (e.type === "tool_call_started") open.add(e.payload.callId);
      // A call is live from the step that logs it until its result, not only once it starts:
      // a parallel sibling still queued behind an approval or the command review has no
      // `tool_call_started` yet, and an earlier sibling's result must not end the step.
      else if (e.type === "assistant_message")
        for (const b of e.payload.content) if (b.type === "tool_call") open.add(b.id);
    }
  }
  return open.size === 0 && !output;
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
  /** Approval / question id → the call it holds (its row waits for a person until decided). */
  const waitCalls = new Map<string, CallState>();
  const waitOn = (
    runId: string | null,
    callId: string,
    what: NonNullable<ToolRowData["waiting"]>,
    id?: string,
    waiter?: Waiter,
  ) => {
    const c = calls.get(callKey(runId, callId));
    if (!c || c.done) return;
    c.tool.row.waiting = what;
    const who = waiter === undefined ? undefined : live.whoWaits?.(waiter);
    if (who === undefined) delete c.tool.row.waitingFor;
    else c.tool.row.waitingFor = who;
    if (id !== undefined) waitCalls.set(id, c);
  };
  const waitEnded = (id: string, ...what: NonNullable<ToolRowData["waiting"]>[]) => {
    const c = waitCalls.get(id);
    if (c && c.tool.row.waiting !== undefined && what.includes(c.tool.row.waiting)) {
      delete c.tool.row.waiting;
      delete c.tool.row.waitingFor;
    }
    waitCalls.delete(id);
  };
  /** Each run's starter (`run_started.triggerAccountId`): who answers its questions and connects. */
  const starters = new Map<string, string>();
  const starterOf = (runId: string | null): Waiter | undefined => {
    const id = runId === null ? undefined : starters.get(runId);
    return id === undefined ? undefined : { kind: "account", accountId: id };
  };
  const modelDenials = new Map<string, { plugin: string; reason: string }>();
  /** Group key → files delivered by its calls / cards of its calls. */
  const groupFiles = new Map<string, { callKey: string; file: FileRef }[]>();
  const groupCards = new Map<string, Extract<TimelineEntry, { kind: "card" }>[]>();
  /** Group key → the network facts of its calls. */
  const groupFacts = new Map<string, Extract<TimelineEntry, { kind: "network-facts" }>[]>();
  const groupDeviceCodes = new Map<string, Extract<TimelineEntry, { kind: "device-code" }>[]>();
  const groupHandoffs = new Map<string, Extract<TimelineEntry, { kind: "handoff" }>[]>();
  const groupReveals = new Map<string, Extract<TimelineEntry, { kind: "reveal" }>[]>();
  /** The last user message (Retry repeats it). */
  let lastUser: RetryMessage | null = null;
  /** Plain user bubbles by seq, and the fork invocations (phase D: who waits for a sub-agent). */
  const plainUsers: Extract<TimelineEntry, { kind: "user" }>[] = [];
  const forks = new Map<number, { label: string; dispatched: boolean; reported: boolean }>();
  /** The highest user seq a model call took in (`model_call.request.absorbedUpToSeq`). */
  let absorbed = 0;
  /** The run going at this point of the log (started, not ended), or null. */
  let current: string | null = null;
  /**
   * Interjections (spec D4) not placed yet, in seq order: a person's bubble logged while
   * {@link current} was going, held until a model call takes it in or its run ends.
   */
  const held: Extract<TimelineEntry, { kind: "user" }>[] = [];
  /** Places the held interjections with a seq up to `upTo` (taken in there). */
  const placeHeld = (upTo: number) => {
    let n = 0;
    while (n < held.length && (held[n] as (typeof held)[number]).seq <= upTo) n++;
    if (n > 0) out.push(...held.splice(0, n));
  };
  /** Places every held interjection (its run ended without taking it in: it starts the next). */
  const placeAllHeld = () => placeHeld(Number.POSITIVE_INFINITY);
  /** What the log says so far of each run (its row's model, working time and tokens). */
  const runs = new Map<
    string,
    {
      /** Its working time (waits for a person left out); null before its start. */
      clock: RunClock | null;
      model: ModelRef | null;
      tokens: RunTokens | null;
      /** `run_started.trigger`: `compact` is a manual compaction (its row names itself). */
      compact: boolean;
    }
  >();
  const runOf = (runId: string) => {
    let r = runs.get(runId);
    if (r === undefined) {
      r = { clock: null, model: null, tokens: null, compact: false };
      runs.set(runId, r);
    }
    return r;
  };
  const runData = (
    e: ConversationEvent,
  ): Pick<RunData, "runId" | "model" | "compact" | "durationMs" | "tokens" | "at"> => {
    const r = e.runId === null ? undefined : runs.get(e.runId);
    // the run's working time, as the status bar counts it (waits for a person left out)
    r?.clock?.end(Date.parse(e.createdAt));
    return {
      runId: e.runId,
      model: r?.model ?? null,
      ...(r?.compact ? { compact: true } : {}),
      durationMs: r?.clock == null ? null : Math.max(0, r.clock.workedMs),
      tokens: r?.tokens ?? null,
      at: e.createdAt,
    };
  };
  /** Whether the event belongs to a manual compact run (`run_started.trigger: "compact"`). */
  const isCompact = (e: ConversationEvent) =>
    e.runId !== null && runs.get(e.runId)?.compact === true;
  /** Failed runs by the user seq they would retry. */
  const failedBySeq = new Map<number, number>();
  /** The model the person switched to (the `from` of a fallback). */
  let switched: ModelRef | null = null;
  /** A fallback divider waiting for its run's `run_started` (its `to`). */
  const fallbacks = new Map<string, number>();
  /** `agent` calls by (runId, callId). */
  const agentCalls = new Map<string, { sub: TimelineSubagent; runId: string | null }>();
  /** `agent` calls whose tool result is in the log. */
  const agentResults = new Set<TimelineSubagent>();
  /** Background task id → its description (from its launch, else its finish). */
  const taskDescriptions = new Map<string, string>();
  /**
   * Background task id → the launch row whose start was not confirmed (`launch_unconfirmed`), shown
   * as reconciling until the task is confirmed running or ends.
   */
  const reconciling = new Map<string, CallState>();
  /**
   * Settles a reconciling launch row: a task that ran (confirmed running, or ended after running)
   * makes it a done start, one that never ran (given up, refused) a failed call with its result.
   */
  const settleLaunch = (taskId: string, ran: boolean) => {
    const c = reconciling.get(taskId);
    if (!c) return;
    reconciling.delete(taskId);
    const row = c.tool.row;
    delete row.notice;
    if (ran) return;
    row.status = "failed";
    const output = row.detail?.output ?? "";
    if (row.blockedBy === undefined) row.error = firstLine(output);
    row.detail = { ...row.detail, errorText: output };
  };
  /** Root-level sub-agent id → the latest wait of an agent below it (agent map spec §7). */
  const deepWaits = new Map<string, { id: string; kind: SubagentWaitKind }>();
  /** Root-level sub-agent id → its waits (`subagent-wait` entries) in log order. */
  const subagentWaits = new Map<string, Extract<TimelineEntry, { kind: "subagent-wait" }>[]>();
  /** Child runs that handed back a report: the description their end entry is named by. */
  const reported = new Map<string, string>();
  /** Child run → the entry of its latest report (a completion right after it merges into it). */
  const reportEntries = new Map<string, Extract<TimelineEntry, { kind: "delivery" }>>();
  /** Child runs (of `reported`) whose end entry is in `out`. */
  const endShown = new Set<string>();
  /** Sub-agent id → its latest dispatch's row and child run. */
  const subagentRows = new Map<
    string,
    { sub: TimelineSubagent; childRunId: string; finished: boolean }
  >();

  /** A child that runs again after an end (a restart or a wake): its row is going again. */
  const reopen = (
    s: { sub: TimelineSubagent; childRunId: string; finished: boolean },
    childRunId: string,
    at: number,
  ) => {
    s.childRunId = childRunId;
    s.finished = false;
    const row = s.sub.row;
    row.status = "running";
    row.toolCalls = 0;
    delete row.waiting;
    delete row.durationMs;
    delete row.finishedAt;
    delete row.tokens;
    if (!Number.isNaN(at)) row.startedAt = at;
  };

  const openSubagents = (step?: StepRef): Extract<TimelineEntry, { kind: "subagents" }> => {
    const last = out.at(-1);
    if (last?.kind === "subagents") return last;
    const g: Extract<TimelineEntry, { kind: "subagents" }> = {
      kind: "subagents",
      key: `s${out.length}`,
      rows: [],
      ...(step !== undefined ? { step } : {}),
    };
    out.push(g);
    return g;
  };

  /** The group a call joins; a new one is keyed by its first call, as its streaming form is (D8). */
  const openGroup = (
    firstCall: string,
    step?: StepRef,
  ): Extract<TimelineEntry, { kind: "tools" }> => {
    const last = out.at(-1);
    if (last?.kind === "tools") return last;
    const g: Extract<TimelineEntry, { kind: "tools" }> = {
      kind: "tools",
      key: toolGroupKey(firstCall),
      rows: [],
      ...(step !== undefined ? { step } : {}),
    };
    out.push(g);
    return g;
  };

  for (const e of events) {
    const key = `e${e.seq}`;
    // a wait for a person stops the run's clock until it is answered
    if (e.runId !== null) runs.get(e.runId)?.clock?.apply(e, Date.parse(e.createdAt));
    switch (e.type) {
      case "run_started":
        if (e.runId !== null) {
          // a new run: what an earlier run (ended without a terminal event) left stands before it
          if (e.runId !== current) placeAllHeld();
          current = e.runId;
          const r = runOf(e.runId);
          // A resumed run writes no second run_started; keep the first start.
          const at = Date.parse(e.createdAt);
          if (r.clock === null) r.clock = new RunClock(at);
          else r.clock.restart(at);
          if (r.model === null) r.model = e.payload.model;
          if (e.payload.trigger === "compact") r.compact = true;
          models.set(e.runId, e.payload.model);
          if (e.payload.triggerAccountId !== undefined)
            starters.set(e.runId, e.payload.triggerAccountId);
          const fb = fallbacks.get(e.runId);
          const d = fb === undefined ? undefined : out[fb];
          if (d?.kind === "divider" && d.divider === "fallback") d.to = e.payload.model;
        }
        break;
      case "model_call":
        // the interjections this request took in stand before its output
        placeHeld(e.payload.request.absorbedUpToSeq);
        absorbed = Math.max(absorbed, e.payload.request.absorbedUpToSeq);
        if (e.runId !== null) {
          const k = stepKey(e.runId, e.payload.step);
          models.set(k, { provider: e.payload.provider, model: e.payload.model });
          stepStarted.set(k, Date.parse(e.createdAt));
          runOf(e.runId).model = { provider: e.payload.provider, model: e.payload.model };
        }
        break;
      case "model_switched":
        if (e.payload.reason === "user") {
          switched = e.payload.model;
          // a person's own switch: one notice line where it applies (the next run on)
          out.push({
            kind: "divider",
            key,
            divider: "switched",
            model: e.payload.model,
            effort: e.payload.effort,
          });
        } else {
          out.push({ kind: "divider", key, divider: "fallback", from: switched, to: null });
          if (e.runId !== null) fallbacks.set(e.runId, out.length - 1);
          switched = null;
        }
        break;
      case "user_message": {
        const dispatch = e.payload.dispatch;
        if (dispatch?.kind === "message") {
          // The parent agent's `SendMessage`: a bubble labelled with its sender.
          const name = live.agentName?.(dispatch.parentConversationId);
          out.push({
            kind: "user",
            key,
            seq: e.seq,
            text: userText(e),
            files: messageFiles(e.payload.content),
            attachments: [],
            sender: {
              id: dispatch.parentConversationId,
              ...(name !== undefined && name !== "" ? { name } : {}),
            },
          });
          break;
        }
        if (dispatch !== undefined) {
          // A sub-agent's task (its parent's prompt), not a person's message.
          out.push({ kind: "task", key, seq: e.seq, text: userText(e) });
          break;
        }
        const skill = e.payload.skill;
        const notice = e.payload.templateSkillNotice;
        if (skill?.template || notice !== undefined) {
          // A template sub-agent's skill the kernel wrote after the task (or its notice that the
          // skill could not be read): part of the task block, never a person's bubble.
          const name = skill?.name ?? notice?.name ?? "";
          const loaded = { label: `/${name}`, instructions: userText(e) };
          const task = out.findLast((x) => x.kind === "task");
          if (task?.kind === "task") task.skills = [...(task.skills ?? []), loaded];
          else out.push({ kind: "task", key, seq: e.seq, text: "", skills: [loaded] });
          break;
        }
        const text = skill ? skill.arguments : userText(e);
        const files = messageFiles(e.payload.content);
        const retryOf = e.payload.retryOf;
        const failed = retryOf === undefined ? undefined : failedBySeq.get(retryOf);
        const d = failed === undefined ? undefined : out[failed];
        if (d?.kind === "run" && d.status === "failed" && !d.retried) {
          // Folded into the failed run ("Retried"), not a second bubble.
          d.retried = true;
        } else {
          const entry: Extract<TimelineEntry, { kind: "user" }> = {
            kind: "user",
            key,
            seq: e.seq,
            text,
            files,
            attachments: e.payload.attachments ?? [],
            authorAccountId: e.payload.authorAccountId,
          };
          if (skill) {
            entry.skill = { label: skillChipLabel(skill.name), mode: skill.mode };
            // A fork's content[0] is the lead for the model, not the instructions: those are the
            // sub-agent's task, which its row opens.
            if (skill.mode === "inline") {
              entry.instructions = joinText(e.payload.content.slice(0, 1), "text");
            }
          } else {
            plainUsers.push(entry);
          }
          // sent while a run goes: it stands where a model call takes it in (spec D4)
          if (current !== null) held.push(entry);
          else out.push(entry);
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
        const at: StepRef | undefined =
          e.runId === null ? undefined : { runId: e.runId, step: e.payload.step };
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
            ...(at !== undefined ? { step: at } : {}),
          });
        }
        // narration when the step also calls a tool, else the answer (process blocks spec §1.1)
        const narration = e.payload.content.some((b) => b.type === "tool_call");
        if (text !== "")
          out.push({
            kind: "prose",
            key,
            text,
            streaming: false,
            narration,
            ...(at !== undefined ? { step: at } : {}),
          });
        for (const b of e.payload.content) {
          if (b.type !== "tool_call") continue;
          const ti = info.get(b.name);
          if (b.name === AGENT_TOOL) {
            const rec = asRecord(b.input);
            const sub: TimelineSubagent = {
              row: {
                id: callKey(e.runId, b.id),
                agentType:
                  typeof rec.subagent_type === "string" ? rec.subagent_type : "general-purpose",
                description: typeof rec.description === "string" ? rec.description : "",
                ...(typeof rec.prompt === "string" ? { prompt: rec.prompt } : {}),
                status: "queued",
                toolCalls: 0,
                // no child yet: the id is the call key until `subagent_dispatched`
                openable: false,
              },
              callId: b.id,
              input: b.input,
            };
            openSubagents(at).rows.push(sub);
            agentCalls.set(callKey(e.runId, b.id), { sub, runId: e.runId });
            continue;
          }
          const input = b.input;
          const rec = asRecord(input);
          const group = openGroup(callKey(e.runId, b.id), at);
          const question = b.name === QUESTION_TOOL;
          const keyArg = question ? questionPreview(input, ti) : keyArgOf(input, ti);
          const kind: ToolRowData["kind"] = question ? "question" : (ti?.kind ?? "tool");
          const command = kind === "command" && typeof rec.command === "string";
          // Claude Code's look: "Bash", "CRM [search]"; before the info arrives, from the key
          const label = ti ? toolLabel(ti, locale) : toolLabelOfKey(b.name);
          // a call counts from when it was logged until its `tool_call_started` says when it
          // started: every live row shows its time, a queued sibling too (spec §1.3)
          const logged = Date.parse(e.createdAt);
          const row: ToolRowData = {
            id: callKey(e.runId, b.id),
            kind,
            name: label.name,
            status: "pending",
            ...(Number.isNaN(logged) ? {} : { startedAt: logged }),
            ...(label.tool !== undefined ? { tool: label.tool } : {}),
            ...(label.tooltip !== undefined ? { tooltip: label.tooltip } : {}),
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
          const tool: TimelineTool = {
            row,
            callId: b.id,
            toolKey: b.name,
            input,
            outputId: null,
            ...(at !== undefined ? { step: at } : {}),
          };
          if (b.name === BASH_TOOL && rec.run_in_background === true)
            tool.background = { taskId: null };
          if (TASK_TOOLS.has(b.name) && typeof rec.task_id === "string") {
            const description = taskDescriptions.get(rec.task_id);
            if (description) row.keyArg = description;
          }
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
          agentResults.add(a.sub);
          // Refused before any dispatch (unknown type, limits): nothing ran; keep the reason.
          if (row.status === "queued") {
            row.status = e.payload.isError ? "failed" : "completed";
            if (e.payload.isError && e.payload.content !== "") row.refusal = e.payload.content;
          }
          break;
        }
        const c = calls.get(callKey(e.runId, e.payload.callId));
        if (!c) break;
        const p = e.payload;
        const row = c.tool.row;
        // the command review's line on the row: a deny is shown with its reason (the error text
        // repeats it in the detail), an allow only in the record for the trajectory
        if (p.review !== undefined) {
          c.tool.review = p.review;
          if (p.review.decision === "deny" && row.extra === undefined) row.extra = p.review.reason;
        }
        const view = p.view;
        // A non-zero exit is information, not a failure (the summary names the code); a timeout or
        // a stopped command fails. A background launch has no exit yet (`exitCode: null` in a
        // result that is no error): it started, and its task's end is a notice of its own. A read-before-write refusal (`guard` view) is the guard working,
        // and a call to a tool the step's request did not carry (`not_loaded` view) is the catalog
        // working: the model still gets an error, the row a neutral outcome.
        const guard = view?.kind === "guard" ? view.reason : undefined;
        const notLoaded = view?.kind === "not_loaded";
        // A background start sent but not confirmed: the kernel reconciles it, so the row is
        // neither done nor failed until the task is confirmed or ends (the model still gets an error).
        const unconfirmed =
          view?.kind === "launch_unconfirmed" && c.tool.background ? view.taskId : undefined;
        const failed =
          (p.isError && guard === undefined && !notLoaded && unconfirmed === undefined) ||
          (view?.kind === "command" &&
            (view.timedOut || (view.exitCode === null && !(c.tool.background && !p.isError)))) ||
          row.blockedBy !== undefined;
        row.status = failed ? "failed" : "done";
        if (guard !== undefined && !failed) row.guard = guard;
        if (notLoaded && !failed) row.notice = "not_loaded";
        if (unconfirmed !== undefined && !failed) {
          row.notice = "reconciling";
          reconciling.set(unconfirmed, c);
        }
        // the review admitted the command outside the OS sandbox (a per-call escalation)
        if (p.review?.sandbox === "escalated") row.outsideSandbox = true;
        // Full access granted the crossing by itself: the row says so, neutrally, with its kind
        if (p.review?.decisionSource === "full-access" && p.review.crossing !== undefined)
          row.autoGranted = p.review.crossing;
        delete row.waiting;
        delete row.waitingFor;
        c.done = true;
        const end = Date.parse(e.createdAt);
        if (c.started !== null && !Number.isNaN(end)) row.durationMs = Math.max(0, end - c.started);
        if (view?.kind === "command" && view.description) row.description = view.description;
        // the exit code goes into the detail; the row names it only when it is not zero
        if (view?.kind === "command" && view.exitCode !== null) row.exitCode = view.exitCode;
        if (view?.kind === "edit") {
          row.keyArg = view.path;
          // A Write over a binary or very large file has no diff: no "+0 −0", no empty diff block
          if (!(view.truncated && view.hunks.length === 0)) {
            row.added = view.added;
            row.removed = view.removed;
            const diff: DiffData = { hunks: view.hunks, truncated: view.truncated };
            row.detail = { ...row.detail, diff };
          }
        }
        if (view?.kind === "read") {
          row.keyArg = view.path;
          if (view.fromLine !== undefined && view.toLine !== undefined)
            c.tool.lines = { from: view.fromLine, to: view.toLine };
        }
        // An extension's display summary (`ToolResult.display`) reads as the row's extra; a
        // command's (the exit code and the command line) does not: the row is "Bash <description>",
        // the command and the exit code are in its detail
        const summary = p.display?.summary[locale];
        if (
          typeof summary === "string" &&
          summary !== "" &&
          view?.kind !== "command" &&
          row.extra === undefined &&
          c.tool.lines === undefined
        )
          row.extra = summary;
        if (p.media !== undefined && p.media.length > 0) c.tool.images = p.media;
        if (failed && row.blockedBy === undefined) row.error = firstLine(p.content);
        row.detail = {
          ...row.detail,
          output: p.content,
          ...(failed ? { errorText: p.content } : {}),
        };
        c.tool.outputId = p.outputId ?? null;
        if (c.tool.background && !failed) {
          const taskId = unconfirmed ?? STARTED_TASK.exec(p.content)?.[1];
          if (taskId !== undefined) {
            c.tool.background = { taskId };
            taskDescriptions.set(taskId, row.description ?? taskId);
          }
        }
        if (p.card) {
          const list = groupCards.get(c.group) ?? [];
          list.push({
            kind: "card",
            key: `${key}:card`,
            plugin: p.card.plugin,
            view: p.card.view,
            callId: p.callId,
            ...(p.card.key !== undefined ? { cardKey: p.card.key } : {}),
            placement: p.card.placement ?? "output",
            ...(p.card.badge !== undefined ? { badge: p.card.badge } : {}),
            ...(p.card.text !== undefined ? { text: p.card.text } : {}),
          });
          groupCards.set(c.group, list);
        }
        if (view?.kind === "handoff" && !p.isError) {
          const list = groupHandoffs.get(c.group) ?? [];
          list.push({
            kind: "handoff",
            key: `${key}:handoff`,
            callId: p.callId,
            title: view.title[locale],
            target: view.target,
          });
          groupHandoffs.set(c.group, list);
        }
        if (view?.kind === "reveal" && !p.isError && e.runId !== null) {
          const list = groupReveals.get(c.group) ?? [];
          const starter = starters.get(e.runId);
          list.push({
            kind: "reveal",
            key: `${key}:reveal`,
            callId: p.callId,
            runId: e.runId,
            reveal: view.reveal,
            ...(starter !== undefined ? { starterAccountId: starter } : {}),
          });
          groupReveals.set(c.group, list);
        }
        break;
      }
      case "tool_ask_decided": {
        // the profile approved the call without asking: the row says so, neutrally
        const c = calls.get(callKey(e.runId, e.payload.callId));
        if (c && e.payload.outcome === "allow")
          c.tool.row.approvedBy =
            e.payload.decisionSource === "full-access" ? "auto" : "review-model";
        break;
      }
      case "network_blocked": {
        // device-layer hosts are the ask's (an approval); unknown ones are explained by the output
        const hosts = e.payload.hosts.flatMap((h) =>
          h.layer === "org" || h.layer === "address" ? [{ host: h.host, layer: h.layer }] : [],
        );
        if (hosts.length === 0) break;
        const fact: Extract<TimelineEntry, { kind: "network-facts" }> = {
          kind: "network-facts",
          key: `${key}:network`,
          callId: e.payload.callId,
          hosts,
        };
        const c = calls.get(callKey(e.runId, e.payload.callId));
        if (c) {
          const list = groupFacts.get(c.group) ?? [];
          list.push(fact);
          groupFacts.set(c.group, list);
        } else out.push(fact);
        break;
      }
      case "device_code": {
        const entry: Extract<TimelineEntry, { kind: "device-code" }> = {
          kind: "device-code",
          key: `${key}:device-code`,
          callId: e.payload.callId,
          url: e.payload.url,
          code: e.payload.code,
        };
        const c = calls.get(callKey(e.runId, e.payload.callId));
        if (c) {
          const list = groupDeviceCodes.get(c.group) ?? [];
          list.push(entry);
          groupDeviceCodes.set(c.group, list);
        } else out.push(entry);
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
          list.push({ callKey: callKey(e.runId, e.payload.callId), file: f });
          groupFiles.set(c.group, list);
        } else {
          const inline = isInlineImageType(f.contentType);
          out.push({
            kind: "files",
            key,
            images: inline ? [{ kind: "image", file: f, ratio: null }] : [],
            others: inline ? [] : [f],
          });
        }
        break;
      }
      case "subagent_dispatched": {
        const invokedSeq = e.payload.invokedSeq;
        if (invokedSeq !== undefined) {
          // its run took the invocation in: the bubble (and what came before it) stands above
          placeHeld(invokedSeq);
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
              // a person's fork invocation waits for its child: foreground
              background: false,
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
        if (!a) {
          // a restart (`SendMessage` to an ended child): its id is the message call's, the row
          // stays the child's own `Agent` call's
          const s = subagentRows.get(e.payload.subagentId);
          if (s) reopen(s, e.payload.childRunId, Date.parse(e.createdAt));
          break;
        }
        const row = a.sub.row;
        row.id = e.payload.subagentId;
        delete row.openable;
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
        // a run that handed back logs no finished delivery when it completes (acceptance
        // 2026-11-07): its end entry comes from here, once (an older log's delivery follows)
        const name = reported.get(e.payload.childRunId);
        if (name !== undefined && !endShown.has(e.payload.childRunId)) {
          endShown.add(e.payload.childRunId);
          // completed right after its own report with nothing drawn between: one line for both
          const last = out.at(-1);
          if (
            e.payload.status === "completed" &&
            last?.kind === "delivery" &&
            last.delivery === "report" &&
            last === reportEntries.get(e.payload.childRunId)
          ) {
            last.delivery = "report-finished";
            last.status = "completed";
          } else {
            out.push({
              kind: "delivery",
              key,
              subagentId: e.payload.subagentId,
              name,
              delivery: "finished",
              status: subagentStatusOfFinish(
                e.payload.status as SubagentFinishStatus,
              ) as DeliveryStatus,
              text: "",
            });
          }
        }
        const s = subagentRows.get(e.payload.subagentId);
        if (!s) break;
        // a late end of an earlier run while a newer one (a restart) is going
        if (!s.finished && s.childRunId !== e.payload.childRunId) break;
        // after an end, another run's end is the child's latest (a wake run writes no dispatch)
        s.childRunId = e.payload.childRunId;
        s.finished = true;
        deepWaits.delete(e.payload.subagentId);
        const row = s.sub.row;
        // A background call's result is logged at dispatch; a child that finished before its
        // call's result was a foreground one (a log written before background sub-agents).
        if (s.sub.input !== undefined && !agentResults.has(s.sub)) row.background = false;
        row.status = subagentStatusOfFinish(e.payload.status as SubagentFinishStatus);
        delete row.waiting;
        row.toolCalls = e.payload.toolCalls;
        row.durationMs = e.payload.durationMs;
        // the run's tokens, summed as the agent tree sums them
        const u = e.payload.usage;
        if (u) row.tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        const at = Date.parse(e.createdAt);
        if (!Number.isNaN(at)) row.finishedAt = at;
        break;
      }
      case "subagent_waiting": {
        // the root's child on the waiting agent's path (the agent itself for a child of the root)
        const path = e.payload.path ?? [e.payload.subagentId];
        const top = path[0] ?? e.payload.subagentId;
        const deep = top !== e.payload.subagentId;
        const s = subagentRows.get(top);
        const row = s?.sub.row;
        // the child's own wait in a run after its last end (a wake): that run is going
        if (s && !deep && s.finished && s.childRunId !== e.payload.childRunId)
          reopen(s, e.payload.childRunId, Number.NaN);
        if (s && row && !s.finished && (deep || s.childRunId === e.payload.childRunId)) {
          row.status = "waiting";
          const waitKind: SubagentWaitKind =
            e.payload.kind === "input" && e.payload.watch === true ? "watch" : e.payload.kind;
          row.waiting = waitKind;
          if (deep) deepWaits.set(top, { id: e.payload.subagentId, kind: waitKind });
          else deepWaits.delete(top);
        }
        const branch = row?.description || row?.agentType || e.payload.subagentId;
        const wait: Extract<TimelineEntry, { kind: "subagent-wait" }> = {
          kind: "subagent-wait",
          key,
          subagent: {
            id: e.payload.subagentId,
            // a deeper agent's name comes from the tree; until then its branch names it
            name: live.agentName?.(e.payload.subagentId) || branch,
          },
          ...(deep ? { deep: true as const } : {}),
          wait: e.payload.kind,
          toolKey: e.payload.toolKey,
          ...(e.payload.approvalId !== undefined ? { approvalId: e.payload.approvalId } : {}),
          ...(e.payload.questionId !== undefined ? { questionId: e.payload.questionId } : {}),
          ...approverField(e.payload),
          ...(e.payload.expiresAt !== undefined ? { expiresAt: e.payload.expiresAt } : {}),
          ...(e.payload.watch === true ? { watch: true as const } : {}),
        };
        out.push(wait);
        const list = subagentWaits.get(top) ?? [];
        list.push(wait);
        subagentWaits.set(top, list);
        break;
      }
      case "subagent_delivery": {
        const p = e.payload;
        if (p.kind === "report") reported.set(p.childRunId, p.description);
        if (p.kind === "finished" && p.handedBack === true) {
          // shown from `subagent_finished`, which the same transaction wrote just before
          if (endShown.has(p.childRunId)) break;
          endShown.add(p.childRunId);
        }
        const entry: Extract<TimelineEntry, { kind: "delivery" }> = {
          kind: "delivery",
          key,
          subagentId: p.subagentId,
          name: p.description,
          delivery: p.kind,
          ...(p.status !== undefined
            ? { status: subagentStatusOfFinish(p.status) as DeliveryStatus }
            : {}),
          text: p.text,
        };
        out.push(entry);
        if (p.kind === "report") reportEntries.set(p.childRunId, entry);
        break;
      }
      case "approval_requested":
        waitOn(e.runId, e.payload.callId, "approval", e.payload.approvalId, approverOf(e.payload));
        approvals.set(e.payload.approvalId, out.length);
        {
          // a command ask's row carries the review's reason (the card shows the rest)
          const asked = calls.get(callKey(e.runId, e.payload.callId));
          const command = e.payload.command;
          if (asked && command !== undefined && asked.tool.row.extra === undefined) {
            asked.tool.row.extra = command.reason;
          }
        }
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
            ...(e.payload.network !== undefined
              ? { network: { hosts: [...e.payload.network.hosts] } }
              : {}),
            ...(e.payload.command !== undefined ? { command: e.payload.command } : {}),
            ...(e.payload.secureInput !== undefined
              ? {
                  secureInput: {
                    target: e.payload.secureInput.target,
                    fields: [...e.payload.secureInput.fields],
                  },
                }
              : {}),
            ...approverField(e.payload),
            decided: null,
            decidedAt: null,
          },
        });
        break;
      case "approval_decided": {
        waitEnded(e.payload.approvalId, "approval");
        const i = approvals.get(e.payload.approvalId);
        const prev = i === undefined ? undefined : out[i];
        if (i !== undefined && prev?.kind === "approval")
          out[i] = { ...prev, item: { ...prev.item, decided: e.payload, decidedAt: e.createdAt } };
        break;
      }
      case "question_asked":
        // a watched wait asks nobody: its own word, no "waiting for X to answer"
        if (e.payload.watch === true)
          waitOn(e.runId, e.payload.callId, "watch", e.payload.questionId);
        else waitOn(e.runId, e.payload.callId, "input", e.payload.questionId, starterOf(e.runId));
        questions.set(e.payload.questionId, out.length);
        out.push({
          kind: "question",
          key,
          item: {
            questionId: e.payload.questionId,
            callId: e.payload.callId,
            form: e.payload.form,
            expiresAt: e.payload.expiresAt,
            ...(e.payload.open !== undefined ? { open: e.payload.open } : {}),
            ...(e.payload.watch === true ? { watch: true as const } : {}),
            answered: null,
          },
        });
        break;
      case "question_answered": {
        waitEnded(e.payload.questionId, "input", "watch");
        const i = questions.get(e.payload.questionId);
        const prev = i === undefined ? undefined : out[i];
        if (i !== undefined && prev?.kind === "question")
          out[i] = { ...prev, item: { ...prev.item, answered: e.payload } };
        break;
      }
      case "connection_required":
        // until the call's result: the run resumes the call once the person connects
        waitOn(e.runId, e.payload.callId, "connect", undefined, starterOf(e.runId));
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
        if (e.runId !== null) {
          const r = runOf(e.runId);
          const p = e.payload;
          const tk = r.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          tk.input += p.inputTokens;
          tk.output += p.outputTokens;
          tk.cacheRead += p.cacheReadTokens;
          tk.cacheWrite += p.cacheWriteTokens;
          tk.total += p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens + p.outputTokens;
          r.tokens = tk;
        }
        break;
      case "background_task_finished": {
        const p = e.payload;
        if (!taskDescriptions.has(p.taskId)) taskDescriptions.set(p.taskId, p.description);
        settleLaunch(p.taskId, !neverRan(p));
        out.push({
          kind: "background",
          key,
          taskId: p.taskId,
          description: p.description,
          status: p.status,
          exitCode: p.exitCode,
        });
        break;
      }
      case "compaction_summary":
        // the summary event's own estimate (context compaction spec §4.9); with nothing saved
        // there is no number to show, so the divider stays plain
        out.push({
          kind: "divider",
          key,
          divider: "compacted",
          summary: e.payload.text,
          savedTokens: savedTokensOf(e.payload.savedTokens),
        });
        break;
      case "compaction_failed":
        // A manual compact run's failure is its outcome (the person clicked "Compact
        // conversation"): a divider says so. An automatic compaction's failure is the step's own
        // concern (it trims instead), so it stays silent.
        if (isCompact(e)) {
          out.push({
            kind: "divider",
            key,
            divider: "compact-failed",
            reason: firstLine(e.payload.reason),
          });
        }
        break;
      case "compaction_skipped":
        // only a manual compact run writes it: its outcome when there was nothing to summarize
        out.push({ kind: "divider", key, divider: "compact-skipped" });
        break;
      case "run_finished":
        // a compact run draws no run row: its outcome is its divider (summary, skip or failure)
        if (isCompact(e)) {
          runData(e);
          break;
        }
        out.push({
          kind: "run",
          key,
          ...runData(e),
          status: "ok",
          ...(RUN_LIMITS.has(e.payload.reason) && { limit: e.payload.reason as RunLimit }),
        });
        break;
      case "run_aborted":
        if (isCompact(e)) {
          runData(e);
          out.push({ kind: "divider", key, divider: "compact-stopped" });
          break;
        }
        out.push({
          kind: "run",
          key,
          ...runData(e),
          status: "stopped",
          byAccountId: e.payload.byAccountId,
        });
        break;
      case "run_failed": {
        const { code, message } = e.payload.error;
        if (isCompact(e)) {
          runData(e);
          out.push({ kind: "divider", key, divider: "compact-failed", reason: firstLine(message) });
          break;
        }
        const denial =
          code === "run.hook_denied" && e.runId !== null ? modelDenials.get(e.runId) : undefined;
        out.push({
          kind: "run",
          key,
          ...runData(e),
          status: "failed",
          code,
          message,
          hook:
            code === "run.hook_denied"
              ? { plugin: denial?.plugin ?? null, reason: denial?.reason ?? null }
              : null,
          retry: lastUser,
          retried: false,
        });
        if (lastUser !== null) failedBySeq.set(lastUser.seq, out.length - 1);
        break;
      }
      default:
        break;
    }
    if (TERMINAL.has(e.type) && e.runId !== null && e.runId === current) {
      // the run ended without taking them in: they stand after its row and start the next run
      current = null;
      placeAllHeld();
    }
  }
  // Not taken in yet while their run goes on: pending, at the bottom (after the drafts).
  for (const h of held) {
    h.pending = true;
    out.push(h);
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
    } else if (!c.done) {
      // A logged Write / Edit keeps its live diff until the result (D8, R13), from its complete
      // input (against the base its streaming row had, when this page saw one); a call with a
      // result or of an ended run computes none.
      const row = c.tool.row;
      const live = loggedLiveView(
        asRecord(c.tool.input),
        info.get(c.tool.toolKey)?.inputView ?? null,
        lastBases.get(row.id),
        c.tool.callId,
      );
      if (live !== undefined) {
        row.detail = { ...row.detail, ...live.detail };
        if (live.added !== undefined) row.added = live.added;
        if (live.removed !== undefined) row.removed = live.removed;
      }
    }
  }
  for (const a of agentCalls.values()) {
    if (a.sub.row.status === "queued" && a.runId !== null && closedRuns.has(a.runId))
      a.sub.row.status = "aborted";
  }
  // A reconciling launch the log has not settled: the list says whether it was confirmed or ended.
  for (const taskId of [...reconciling.keys()]) {
    const t = live.backgroundTasks?.get(taskId);
    if (t === undefined || (t.status === "running" && t.starting === true)) continue;
    settleLaunch(taskId, !neverRan(t));
  }
  // What the log does not say yet: live calls, and a child waiting or queued again.
  for (const [id, s] of subagentRows) {
    const row = s.sub.row;
    if (s.finished) {
      // the list's latest run started after the log's last end (a wake, a restart not logged yet)
      const v = live.views?.get(id);
      const started = v?.startedAt === undefined ? Number.NaN : Date.parse(v.startedAt);
      if (
        v === undefined ||
        !isActiveView(v.status) ||
        row.finishedAt === undefined ||
        !(started > row.finishedAt)
      )
        continue;
      reopen(s, s.childRunId, started);
    }
    const p = live.progress?.[id];
    const calls = p?.toolCalls;
    if (calls !== undefined && calls > row.toolCalls) row.toolCalls = calls;
    // the status line names the current tool only for a background child (§9.5)
    if (p?.lastToolKey !== undefined && row.background !== false) {
      const ti = info.get(p.lastToolKey);
      row.current = toolLabelText(ti ? toolLabel(ti, locale) : toolLabelOfKey(p.lastToolKey));
    }
    const v = live.views?.get(id);
    if (v !== undefined) {
      if (v.status === "waiting") {
        row.status = "waiting";
        row.waiting = subagentWaitKind(v);
      } else if (v.status === "running" || v.status === "queued") {
        row.status = v.status;
        delete row.waiting;
      }
    }
    // an agent below waits for a person (the list knows only the child's own state)
    const d = deepWaits.get(id);
    if (d !== undefined && v?.status !== "waiting") {
      const st = live.agentStatus?.(d.id);
      if (st === undefined || st === "waiting") {
        row.status = "waiting";
        row.waiting = d.kind;
      } else if (v === undefined) {
        // the tree says it went on: the log's mark is stale
        row.status = "running";
        delete row.waiting;
      }
    }
  }

  // A sub-agent's wait is over once a later wait of the same root-level child replaced it, or its
  // row (after the live pass above) no longer waits; a connection only once the child ended (its
  // call goes on without waiting, so the row runs while the line still offers to open it). A
  // child the log never dispatched stays open.
  for (const [top, waits] of subagentWaits) {
    const s = subagentRows.get(top);
    waits.forEach((w, i) => {
      const over =
        s !== undefined && (w.wait === "connect" ? s.finished : s.sub.row.status !== "waiting");
      if (i < waits.length - 1 || over) w.ended = true;
    });
  }

  // One connect card per connector: each tool that hits a missing connection asks again, so only
  // the latest card of a connector stays (it is the live one; the earlier ones are its repeats).
  const lastConnect = new Map<string, string>();
  for (const entry of out) {
    if (entry.kind === "connect") lastConnect.set(entry.item.connectorId, entry.key);
  }
  const shown = out.filter(
    (entry) => entry.kind !== "connect" || lastConnect.get(entry.item.connectorId) === entry.key,
  );

  // After the pass above: a call of an ended run is cancelled, so it draws no placeholder.
  const generating = (t: TimelineTool) =>
    t.toolKey === GENERATE_IMAGE_TOOL && t.row.status === "running" && t.row.waiting === undefined;
  if (
    groupFiles.size === 0 &&
    groupCards.size === 0 &&
    groupFacts.size === 0 &&
    groupDeviceCodes.size === 0 &&
    groupHandoffs.size === 0 &&
    groupReveals.size === 0 &&
    !shown.some((entry) => entry.kind === "tools" && entry.rows.some(generating))
  )
    return { entries: shown, modelOf, info, locale };
  const withExtras: TimelineEntry[] = [];
  for (const entry of shown) {
    withExtras.push(entry);
    if (entry.kind !== "tools") continue;
    const delivered = groupFiles.get(entry.key) ?? [];
    const images: ImageSlot[] = [];
    for (const t of entry.rows) {
      const isGen = t.toolKey === GENERATE_IMAGE_TOOL;
      const requested = asRecord(t.input).aspect_ratio;
      const ratio = isGen && isImageRatio(requested) ? requested : null;
      let have = 0;
      for (const d of delivered) {
        if (d.callKey !== t.row.id || !isInlineImageType(d.file.contentType)) continue;
        images.push({ kind: "image", file: d.file, ratio });
        have++;
      }
      if (!generating(t)) continue;
      const want = wantedImages(t.input);
      for (let index = have; index < want; index++)
        images.push({
          kind: "generating",
          key: `${t.row.id}:${index}`,
          callId: t.callId,
          ratio,
          index,
          count: want,
        });
    }
    const others = delivered
      .filter((d) => !isInlineImageType(d.file.contentType))
      .map((d) => d.file);
    if (images.length > 0 || others.length > 0)
      withExtras.push({ kind: "files", key: `${entry.key}:files`, images, others });
    for (const card of groupCards.get(entry.key) ?? []) withExtras.push(card);
    for (const fact of groupFacts.get(entry.key) ?? []) withExtras.push(fact);
    for (const device of groupDeviceCodes.get(entry.key) ?? []) withExtras.push(device);
    for (const handoff of groupHandoffs.get(entry.key) ?? []) withExtras.push(handoff);
    for (const reveal of groupReveals.get(entry.key) ?? []) withExtras.push(reveal);
  }
  return { entries: withExtras, modelOf, info, locale };
}

/** Turns, elapsed time and the running state for the status bar. */
export interface RunStats {
  /** `run_started` count. */
  turns: number;
  /** The run going now (between its `run_started` and its terminal event), else null. */
  runId: string | null;
  /** Start of the current or last run (ms), or null. */
  startedAt: number | null;
  /** End of the last run (ms); null while one is active. */
  endedAt: number | null;
  /** How the last run ended (null while active or before any run). */
  last: "finished" | "failed" | "aborted" | null;
  /**
   * The current or last run's working time up to {@link resumedAt} (ms): its span without the
   * time it waited for a person (an approval, a question), which is not working.
   */
  workedMs: number;
  /**
   * When the current run last started working (ms): its start, or the end of its last wait. Null
   * while it waits for a person, after it ended and before any run, so nothing ticks then.
   */
  resumedAt: number | null;
  /** What the current run waits for while it waits for a person, else null. */
  waitingFor: "approval" | "input" | null;
}

/** The running time the status bar shows: worked time, plus the open working stretch. */
export const workedMsAt = (s: RunStats, now: number): number | null =>
  s.startedAt === null ? null : s.workedMs + (s.resumedAt === null ? 0 : now - s.resumedAt);

/**
 * One run's working time: from its start to its end without its waits for a person (an approval,
 * a question; {@link PersonWaits}). The status bar's elapsed time and the run row's duration both
 * read it, so the two agree.
 */
class RunClock {
  /** Working time before {@link resumedAt}. */
  workedMs = 0;
  /** When the run last started working; null while it waits and after it ended. */
  resumedAt: number | null;
  private readonly waits = new PersonWaits();

  /** What it waits for while it waits for a person, else null. */
  get waitingFor(): "approval" | "input" | null {
    return this.waits.kind;
  }

  constructor(at: number) {
    this.resumedAt = at;
  }

  /** A repeated `run_started` of the same run (a resumed run writes none, but be safe). */
  restart(at: number): void {
    if (!this.waits.waiting) this.resumedAt ??= at;
  }

  /** An event of the run: a wait starts or its last open wait ends. */
  apply(e: ConversationEvent, at: number): void {
    const change = this.waits.apply(e);
    if (change === "start") {
      if (this.resumedAt !== null) this.workedMs += at - this.resumedAt;
      this.resumedAt = null;
    } else if (change === "end") {
      this.resumedAt = at;
    }
  }

  /** The run's terminal event. */
  end(at: number): void {
    if (this.resumedAt !== null) this.workedMs += at - this.resumedAt;
    this.resumedAt = null;
    this.waits.clear();
  }
}

export function runStats(events: readonly ConversationEvent[]): RunStats {
  let turns = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let last: RunStats["last"] = null;
  let active: string | null = null;
  let clock: RunClock | null = null;
  for (const e of events) {
    const at = Date.parse(e.createdAt);
    if (e.type === "run_started") {
      // A resumed run writes no second run_started; a new runId is a new turn.
      if (e.runId !== active || clock === null) {
        turns += 1;
        clock = new RunClock(at);
      } else clock.restart(at);
      active = e.runId;
      startedAt = at;
      endedAt = null;
      last = null;
    } else if (e.runId === null || e.runId !== active) {
    } else if (TERMINAL.has(e.type)) {
      clock?.end(at);
      endedAt = at;
      last =
        e.type === "run_finished" ? "finished" : e.type === "run_failed" ? "failed" : "aborted";
      active = null;
    } else {
      clock?.apply(e, at);
    }
  }
  return {
    turns,
    runId: active,
    startedAt,
    endedAt,
    last,
    workedMs: Math.max(0, clock?.workedMs ?? 0),
    resumedAt: clock?.resumedAt ?? null,
    waitingFor: active === null ? null : (clock?.waitingFor ?? null),
  };
}

export { toolKeysOf } from "./tool-keys";

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
 * the old history, a title call a short excerpt and a `web_fetch` call one fetched page, so none
 * counts.
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
