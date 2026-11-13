import type { AgentProfile } from "./agents";
import { apiFetch } from "./api";
import type { OrgRole } from "./members";

/**
 * 内核会话 API 的类型（浏览器端视角：只声明界面用到的字段；时间为 JSON 字符串）。
 * 与内核 `packages/kernel/src/conversations/events.ts` 的事件形状对应。Web 层不 import 内核代码。
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; content: string; isError: boolean }
  /** 上传的附件（只出现在 user 消息里）：日志里只有引用，字节经 download 取。 */
  | { type: "image"; mediaType: string; source: MediaSource; name?: string }
  | { type: "document"; mediaType: string; source: MediaSource; name?: string };

/** 媒体块的来源：日志里只会是 `ref`（字节不进日志）。 */
export type MediaSource = { kind: "ref"; attachmentId: string } | { kind: "base64"; data: string };

type FormText = string | { zh: string; en: string };

/**
 * 用户消息附带的资源（内核读取正文，这里只有元数据）。`appId` / `appName` 是连接器的 id 与名称：
 * 事件 payload 字段名在「应用」改名「连接器」后不变（内核 C27）。
 */
export interface MessageAttachment {
  appId: string;
  appName: string;
  uri: string;
  name: string;
}

/** 交互表单（内核输入请求的 `form`，与 plugin-sdk 的 `InputForm` 对应）。 */
export interface InputForm {
  title: FormText;
  /** 需要用户在浏览器里打开的外部页面（MCP URL 模式的 elicitation）。 */
  url?: string;
  fields: {
    key: string;
    label: FormText;
    description?: FormText;
    schema: Record<string, unknown>;
    multiSelect?: boolean;
    allowOther?: boolean;
    required?: boolean;
  }[];
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

/** `tool_result` 的显示摘要（plugin-sdk `ToolResult.display`）。 */
export interface ToolDisplay {
  summary: { zh: string; en: string };
}

/** Which rule asked for an approval (kernel `ApprovalPolicySource`). */
export type ApprovalPolicy =
  | "agent"
  | "connector"
  | "member"
  | "default"
  | "role"
  | "org"
  | "fixed";

/**
 * A command review's decision on a tool call (auto mode spec §5.4; display only): who decided
 * (the rule table, the classifier or the person through a `command` ask) and why.
 */
export interface ReviewRecord {
  decision: "allow" | "deny";
  by: "rule" | "classifier" | "person";
  rule: string | null;
  reason: string;
  /** The person's choice (a `session` one covers the rule for the conversation). */
  scope?: "once" | "session";
  /** SHA-256 of the command text a `command` approval holds in full (person decisions). */
  commandHash?: string;
}

/** A `command` ask's facts (auto mode spec §5.4; display only). */
export interface CommandAsk {
  kind: "command" | "write";
  /** The command text, or the tool key of the write. */
  command: string;
  /** A write's target path. */
  path?: string;
  rule: string | null;
  reason: string;
  mode: "auto" | "sandbox";
}

/**
 * Which layer refused a network host (network ask spec §4.1): the device's own policy, the org's
 * egress, a private or local address, or unknown.
 */
export type NetworkBlockedLayer = "device" | "org" | "address" | "unknown";

/** `tool_result.view` (kernel `ToolViewSchema`): display only. */
export type ToolView =
  | { kind: "command"; description?: string; exitCode: number | null; timedOut: boolean }
  | {
      kind: "edit";
      path: string;
      created: boolean;
      added: number;
      removed: number;
      truncated: boolean;
      hunks: {
        oldStart: number;
        newStart: number;
        lines: { kind: "ctx" | "add" | "del"; text: string }[];
      }[];
    }
  | { kind: "read"; path: string; fromLine?: number; toLine?: number }
  /** `Edit` / `Write` refused by the read-before-write check: a neutral outcome, not a failure. */
  | { kind: "guard"; reason: "not_read" | "modified" };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other" | "aborted";

type EventBody =
  | {
      type: "user_message";
      payload: {
        content: ContentBlock[];
        /** `@` 资源引用的附件：第 i 个附件的正文是 `content[i + 1]`。 */
        attachments?: MessageAttachment[];
        authorAccountId: string;
        /**
         * Who wrote it, at send time (model-facing data; the page names authors from the live
         * account and shows no per-message senders).
         */
        sender?: { name: string; role?: OrgRole; anonymous?: true };
        /** The sender's time zone and language at send time (the next run's context). */
        timeZone?: string;
        locale?: "zh" | "en";
        clientMessageId?: string;
        /** A retry after a failed run: the seq of the message it repeats (display only). */
        retryOf?: number;
        /**
         * A message to a sub-agent from its parent agent (phase C, agent map spec §5.1): the
         * dispatch's task (`kind` absent or `task`), or a `SendMessage` (`message`).
         */
        dispatch?: {
          parentConversationId: string;
          parentRunId: string;
          callId: string;
          kind?: "task" | "message";
        };
        /**
         * A person's skill invocation (phase D): `content[0]` is the rendered skill, this is what
         * they typed (the chip and the arguments).
         */
        skill?: SkillInvocationRecord;
      };
    }
  | {
      /** The person switched model / effort, or the kernel fell back to the agent's model. */
      type: "model_switched";
      payload: {
        model: ModelRef | null;
        effort: string | null;
        byAccountId: string | null;
        reason: "user" | "unavailable";
      };
    }
  | {
      type: "run_started";
      payload: { agentVersion: number; model: ModelRef; triggerAccountId?: string };
    }
  | {
      type: "model_call";
      payload: {
        step: number;
        provider: string;
        model: string;
        /**
         * The user messages the request took in (absent in older logs) and the tools it offered
         * by key.
         */
        request?: { absorbedUpToSeq?: number; tools?: { key: string }[] };
      };
    }
  | {
      type: "assistant_message";
      payload: { step: number; content: ContentBlock[]; stopReason: StopReason };
    }
  | {
      type: "usage";
      payload: {
        step: number;
        provider: string;
        model: string;
        /** 未缓存的输入；输入总量 = inputTokens + cacheReadTokens + cacheWriteTokens。 */
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        /**
         * Set when the usage is not the step's call: `compaction`, `title`, or `web_fetch` (a
         * `WebFetch` extraction call, with that call's `callId`).
         */
        purpose?: "compaction" | "title" | "web_fetch";
        callId?: string;
      };
    }
  | { type: "reminder"; payload: { step: number; text: string } }
  /** The model's tool set changed since its previous request (model-facing; the UI shows nothing). */
  | { type: "tools_changed"; payload: { step: number; added: string[]; removed: string[] } }
  /**
   * Who the agent is and the facts of the day, written at run start (model-facing; the UI shows
   * nothing).
   */
  | {
      type: "run_context";
      payload: {
        agent?: { name: string; description?: string };
        org?: { name: string };
        date?: string;
        timeZone?: string;
        locale?: "zh" | "en";
        dispatchedBy?: { agent: string; person: string };
      };
    }
  | {
      type: "tool_call_started";
      payload: { step: number; callId: string; toolKey: string; specHash: string };
    }
  | {
      type: "tool_result";
      payload: {
        step: number;
        callId: string;
        toolKey: string;
        content: string;
        isError: boolean;
        outputId?: string;
        contentTypes?: string[];
        loadedTools?: string[];
        /** 工具给的一句说明（中英各一份，只用于显示，不进模型上下文）。 */
        display?: ToolDisplay;
        /** Structured view of a builtin's result (display only). */
        view?: ToolView;
        /** An inline card under the call (an `inline` ui contribution of the tool's extension). */
        card?: { plugin: string; view: string; key?: string };
        /** The command review's decision on the call (auto mode spec §5.4; display only). */
        review?: ReviewRecord;
      };
    }
  | {
      type: "connection_required";
      payload: { step: number; callId: string; appId: string; appName: string };
    }
  | {
      type: "approval_requested";
      payload: {
        step: number;
        callId: string;
        approvalId: string;
        toolKey: string;
        expiresAt: string;
        /** Which rule asked (display only; absent in older logs). */
        policy?: ApprovalPolicy;
        /** A network ask: the device-layer hosts asked for (display only). */
        network?: { hosts: string[] };
        /** A command review ask: what is held and why (display only). */
        command?: CommandAsk;
      } & Approver;
    }
  | {
      type: "approval_decided";
      payload: {
        approvalId: string;
        callId: string;
        /** `skipped`: a network ask the person answered with a message instead. */
        decision: "approved" | "denied" | "expired" | "cancelled" | "skipped";
        scope?: "once" | "session" | "always";
        byAccountId: string | null;
        /** The reason given with a denial. */
        reason?: string;
      };
    }
  /**
   * A still-pending approval changed without a decision (a network ask's device change that did
   * not take effect: its `detail.attempt`): the card reads the approval again. Display only.
   */
  | { type: "approval_updated"; payload: { approvalId: string; callId: string } }
  /**
   * A command on a device was refused network hosts (display only, never model-visible): each
   * host with the layer that refused it. Device-layer hosts are asked about in an approval; the
   * org and address layers are facts under the command's row.
   */
  | {
      type: "network_blocked";
      payload: {
        step: number;
        callId: string;
        hosts: { host: string; port: number; layer: NetworkBlockedLayer }[];
      };
    }
  | {
      type: "question_asked";
      payload: {
        step: number;
        callId: string;
        questionId: string;
        form: InputForm;
        expiresAt: string;
      };
    }
  | {
      type: "question_answered";
      payload: {
        questionId: string;
        callId: string;
        answer: FormAnswer | null;
        byAccountId: string | null;
        /** `skipped`: the run's starter sent a message instead of answering. */
        outcome: "answered" | "skipped" | "expired" | "cancelled";
        /** `skipped` only: the seq of the `user_message` that skipped it (lower than this event's). */
        skippedBySeq?: number;
      };
    }
  | {
      /** agent 经 `Deliver` 交付的文件（产物）：字节在对象存储，经 artifacts 下载接口取。 */
      type: "artifact_created";
      payload: {
        artifactId: string;
        name: string;
        contentType: string;
        size: number;
        sourcePath: string;
        callId: string;
      };
    }
  | {
      /** 此刻生效的技能目录快照（运行开始时目录变了才写；界面不显示）。 */
      type: "skills_catalog";
      payload: {
        skills: {
          id: string;
          name: string;
          description: string;
          version: number;
          source: string;
        }[];
      };
    }
  /**
   * The paths the sandbox tools use in the conversation's device (written on its first
   * sandbox call and whenever they change; model-facing, the UI shows nothing).
   */
  | {
      type: "device_paths";
      payload: { roots: { workspace: string; skills: string; tmp: string } };
    }
  /** A background `Bash` task ended (background Bash spec §2): the thread's one-line notice. */
  | {
      type: "background_task_finished";
      payload: {
        taskId: string;
        description: string;
        status: Exclude<BackgroundTaskStatus, "running">;
        exitCode: number | null;
        elapsedMs: number;
        /** The output's last lines (at most 20 lines, 4000 characters). */
        lastLines: string;
        outputPath: string;
        reported: boolean;
        lostReason?: string;
        stoppedBy?: "person" | "deletion" | "subagent_end";
      };
    }
  | { type: "compaction_summary"; payload: { coversUpToSeq: number; text: string } }
  | { type: "compaction_failed"; payload: { attempt: number; reason: string } }
  | {
      type: "media_excluded";
      payload: { attachmentIds: string[]; reason: "provider_rejected" };
    }
  | { type: "run_finished"; payload: { reason: string; consumedUpToSeq: number } }
  | { type: "run_failed"; payload: { error: { code: string; message: string } } }
  /** A plugin policy hook denied a model request or a tool call (the timeline names the plugin). */
  | {
      type: "hook_denied";
      payload: {
        mount: "model.request" | "tool.preExecute";
        plugin: string;
        reason: string;
        cause: "deny" | "hook_error" | "timeout";
        step: number;
        attempt?: number;
        callId?: string;
      };
    }
  | { type: "run_aborted"; payload: { byAccountId: string | null; reason: string } }
  /**
   * A sub-agent conversation's first event (phase C): who dispatched it, its roster type, where its
   * definition came from (an org agent: `source: "agent"`, `id` its agent id) and the frozen
   * (narrowed) definition.
   */
  | {
      type: "subagent_started";
      payload: {
        parent: { conversationId: string; runId: string; callId: string; step: number };
        agentType: string;
        template: {
          source: "general" | "inline" | "plugin" | "agent";
          id?: string;
          version?: number;
          plugin?: string;
        };
        definition: { name: string; [key: string]: unknown };
        maxSteps: number;
        warnings?: string[];
      };
    }
  /** Parent log: the `agent` call `callId` started (or resumed) the sub-agent `subagentId`. */
  | {
      type: "subagent_dispatched";
      payload: {
        step: number;
        callId: string;
        subagentId: string;
        childRunId: string;
        agentType: string;
        description: string;
        resumed: boolean;
        model: ModelRef;
        tierFallback?: boolean;
        /** Phase D: the person's fork invocation this dispatch runs (`callId` `skill-<seq>`). */
        invokedSeq?: number;
      };
    }
  /**
   * Root log: a sub-agent of the tree, at any depth, waits for a person (its approval, question or
   * connection). `path`: the child conversation ids from the root's child down to `subagentId`
   * (absent in logs written before nesting, where it was the parent's own child).
   */
  | {
      type: "subagent_waiting";
      payload: {
        subagentId: string;
        childRunId: string;
        path?: string[];
        kind: "approval" | "input" | "connect";
        approvalId?: string;
        questionId?: string;
        toolKey: string;
        expiresAt?: string;
      } & Approver;
    }
  /**
   * Parent log (agent map spec §4.5): a sub-agent's report (`SubagentHandback`), its note
   * (`SendMessage` to the parent) or its run's end; model-visible.
   */
  | {
      type: "subagent_delivery";
      payload: {
        subagentId: string;
        childRunId: string;
        description: string;
        kind: "report" | "note" | "finished";
        text: string;
        /** `finished` only. */
        status?: SubagentEndStatus;
        /** `finished` only: a report was handed back before (no text then). */
        handedBack?: boolean;
        errorCode?: string;
        abortedBy?: "user" | "parent";
        triggerAccountId: string;
      };
    }
  /** Parent log: a sub-agent's run ended. */
  | {
      type: "subagent_finished";
      payload: {
        subagentId: string;
        childRunId: string;
        callId: string;
        status: SubagentEndStatus;
        errorCode?: string;
        toolCalls: number;
        durationMs: number;
        usage: ConversationUsage;
      };
    };

/** The `skill` of a person's invocation message (kernel `user_message.skill`, phase D). */
export interface SkillInvocationRecord {
  id: string;
  version: number;
  source: string;
  /** The skill's bare name. */
  name: string;
  plugin?: string;
  /** As typed (trimmed). */
  arguments: string;
  mode: "inline" | "fork";
  /** Fork only: the sub-agent type it ran as. */
  agentType?: string;
}

/** Phase D: the report of the sub-agent that ran a person's fork invocation (model-visible). */
type SkillForkResultBody = {
  type: "skill_fork_result";
  payload: { invokedSeq: number; subagentId?: string; childRunId?: string; text: string };
};

/** How a sub-agent's run ended (`subagent_finished.status`). */
export type SubagentEndStatus =
  | "completed"
  | "max_steps"
  | "max_duration"
  | "budget"
  | "aborted"
  | "timed_out"
  | "failed";

/** Token usage summed over events (`GET .../usage`, a `subagent_finished`). */
export interface ConversationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Who may decide an approval (display only, absent in older logs): the assigned member, else the
 * escalation role (`approval_requested`, and a sub-agent's in `subagent_waiting`).
 */
export interface Approver {
  requestedFor?: string | null;
  approverRole?: OrgRole | null;
}

/** 已写入日志的会话事件。 */
export type ConversationEvent = (EventBody | SkillForkResultBody) & {
  conversationId: string;
  seq: number;
  runId: string | null;
  createdAt: string;
};

export interface ModelRef {
  provider: string;
  model: string;
}

/** The model / effort a person switched to; nulls = the agent's own. */
export interface Selection {
  model: ModelRef | null;
  effort: string | null;
}

export interface Conversation {
  id: string;
  orgId: string;
  agentId: string;
  title: string | null;
  /** Who wrote `title` (absent on older kernels). */
  titleSource?: "generated" | "manual" | null;
  selection?: Selection;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  /** A sub-agent conversation's parent (null or absent for a chat conversation). */
  parentConversationId?: string | null;
  /** A sub-agent conversation's roster type. */
  subagentType?: string | null;
  /** The conversation's owner. */
  accountId?: string;
  /** The device it runs in, bound at the first message (null: none, or an older kernel). */
  deviceId?: string | null;
  /** The scheduled task that started it (a `new`-mode task); null otherwise. */
  scheduledTaskId?: string | null;
  /** What it is doing now: a run in progress, or waiting for me (absent on older kernels). */
  activity?: "running" | "waiting" | null;
}

/** A parent conversation's sub-agent (`GET .../conversations/:id/subagents`). */
export interface SubagentView {
  id: string;
  agentType: string;
  description: string;
  /** The latest run's status (`runs.status`). */
  status: string;
  /** Tool calls of the latest run. */
  toolCalls: number;
  startedAt: string;
  finishedAt: string | null;
  usage: ConversationUsage;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
}

/** A background `Bash` task's status (kernel `BackgroundTaskStatus`). */
export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "lost";

/** A background task (`GET .../conversations/:id/background-tasks`). */
export interface BackgroundTaskView {
  id: string;
  /** The conversation the task was asked for. */
  conversationId: string;
  /** The sub-agent (child conversation) that started it; null for the conversation's own. */
  subagentId: string | null;
  description: string;
  command: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  lostReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** A stop is under way (another request is handling it); the task still runs. */
  stopping: boolean;
}

/**
 * Why a task's output cannot be read live (kernel `OutputUnavailable`): the reason and where the
 * task ran, a `local` device or a `cloud` sandbox.
 */
export interface BackgroundTaskUnavailable {
  reason:
    | "starting"
    | "not_started"
    | "device_offline"
    | "suspended"
    | "rebuilt"
    | "output_missing"
    | "no_access"
    | "unavailable"
    | "read_failed";
  environment: "local" | "cloud";
}

/**
 * The end of a task's output (`live`: read from the environment; `event`: the finish's last
 * lines, with why it was not read live).
 */
export interface BackgroundTaskOutput {
  text: string;
  truncated: boolean;
  source: "live" | "event";
  unavailable?: BackgroundTaskUnavailable;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations`;
const one = (orgId: string, id: string) => `${base(orgId)}/${encodeURIComponent(id)}`;

/** 每页事件上限（内核 `limit` 的最大值）。 */
export const EVENTS_PAGE = 500;

export const createConversation = (orgId: string, agentId: string) =>
  apiFetch<{ conversation: Conversation }>(base(orgId), {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });

/** What a message carries besides its text (`POST …/messages`, the first message). */
export interface MessageInput {
  text: string;
  clientMessageId: string;
  attachments?: { connectorId: string; uri: string }[];
  files?: string[];
  /** Switch the conversation's model from the next run (the agent's own model = back to it). */
  model?: ModelRef;
  effort?: string;
  /** A retry after a failed run: the seq of the repeated message. */
  retryOf?: number;
  /** Invoke this skill (phase D): `text` is its arguments. */
  skill?: { name: string };
}

/**
 * The sender's browser time zone and UI language, sent with every message (run context spec
 * §3.4): the kernel uses them unless the person set a time zone in their preferences.
 */
export function browserContext(): { timeZone?: string; locale?: "zh" | "en" } {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    timeZone = undefined;
  }
  const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
  const locale = lang === "zh" || lang === "en" ? lang : undefined;
  return {
    ...(timeZone !== undefined && { timeZone }),
    ...(locale !== undefined && { locale }),
  };
}

const messageBody = (m: MessageInput) => ({
  text: m.text,
  clientMessageId: m.clientMessageId,
  ...(m.attachments !== undefined && m.attachments.length > 0 && { attachments: m.attachments }),
  ...(m.files !== undefined && m.files.length > 0 && { files: m.files }),
  ...(m.model !== undefined && { model: m.model }),
  ...(m.effort !== undefined && { effort: m.effort }),
  ...(m.retryOf !== undefined && { retryOf: m.retryOf }),
  ...(m.skill !== undefined && { skill: m.skill }),
  ...browserContext(),
});

/**
 * Create on first send: the conversation and its first message in one call. A retry with the same
 * `clientMessageId` returns the same conversation.
 */
export const createConversationWithMessage = (
  orgId: string,
  agentId: string,
  message: Omit<MessageInput, "retryOf">,
  deviceId?: string,
) =>
  apiFetch<{
    conversation: Conversation;
    event: ConversationEvent;
    /** Every event the create wrote, from seq 1 (a `model_switched` first); older kernels omit it. */
    events?: ConversationEvent[];
  }>(base(orgId), {
    method: "POST",
    body: JSON.stringify({
      agentId,
      message: messageBody(message),
      ...(deviceId !== undefined ? { deviceId } : {}),
    }),
  });

/** Rename (owner only): a manual title is never regenerated. */
export const renameConversation = (orgId: string, id: string, title: string) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });

/** Archive or unarchive (owner only); archiving does not stop a running run. */
export const archiveConversation = (orgId: string, id: string, archived: boolean) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });

/** Delete (owner only, soft): stops a running run first. */
export const deleteConversation = (orgId: string, id: string) =>
  apiFetch<void>(one(orgId, id), { method: "DELETE" });

/** One agent's group of my conversations (`GET .../conversations/groups`, the sidebar). */
export interface ConversationGroup {
  /** The agent's name and the avatar half of its profile, as the agents API returns them. */
  agent: { id: string; name: string; profile: Pick<AgentProfile, "avatar" | "updatedAt"> };
  /** The group's latest activity (ISO). */
  latestAt: string;
  /** At most `perGroup`, newest first. */
  conversations: Conversation[];
  /** The group has more conversations than it lists (load them with `listConversations`). */
  more: boolean;
}

/** A query string from the defined options, in the given order (`""` when none is set). */
function query(opts: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/**
 * What narrows my conversations (web order §2.1): a title substring (`q`, case-insensitive), a run
 * state, and the archived list instead of the live one. A blank `q` and state `all` are omitted
 * (the kernel rejects `?q=`); `q` is cut to the kernel's 100 characters.
 */
export type ConversationSearch = {
  q?: string;
  state?: "all" | "running" | "waiting";
  archived?: boolean;
};

const searchQuery = (s: ConversationSearch) => {
  const q = s.q?.trim().slice(0, 100);
  return {
    q: q === "" ? undefined : q,
    state: s.state === undefined || s.state === "all" ? undefined : s.state,
    archived: s.archived === true ? "1" : undefined,
  };
};

/** One page of {@link listConversationGroups}. */
export interface ConversationGroupsPage {
  groups: ConversationGroup[];
  next: string | null;
  archivedCount?: number;
}

/**
 * My conversations grouped by agent, by latest activity; `next` is passed back as `after`.
 * `archivedCount` counts my archived conversations whatever the search (the archived entry).
 *
 * The cursor is the last group's agent id, re-read at that group's latest activity when the next
 * page is asked for: a group that gets new activity between two pages can come back on the next
 * page (and one that moved up is skipped until a reload). Callers merge pages by agent id
 * (`useConversationGroups`).
 */
export const listConversationGroups = (
  orgId: string,
  opts: { perGroup?: number; limit?: number; after?: string } & ConversationSearch = {},
) =>
  apiFetch<ConversationGroupsPage>(
    `${base(orgId)}/groups${query({
      perGroup: opts.perGroup,
      limit: opts.limit,
      after: opts.after,
      ...searchQuery(opts),
    })}`,
  );

/** My conversations, newest first; `agentId` keeps one agent's (a group's "More"). */
export const listConversations = (
  orgId: string,
  opts: { agentId?: string; after?: string; limit?: number } & ConversationSearch = {},
) =>
  apiFetch<{ conversations: Conversation[]; next: string | null }>(
    `${base(orgId)}${query({
      agentId: opts.agentId,
      after: opts.after,
      limit: opts.limit,
      ...searchQuery(opts),
    })}`,
  );

export const getConversation = (orgId: string, id: string) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id));

export const listEvents = (orgId: string, id: string, after: number, limit = EVENTS_PAGE) =>
  apiFetch<{ events: ConversationEvent[] }>(
    `${one(orgId, id)}/events?after=${after}&limit=${limit}`,
  );

/**
 * Whether `events` (the cached window of a log) start at the log's beginning: seqs are allocated
 * from 1 without gaps, so the first event has seq 1 (an empty log has nothing before it either).
 */
export const fromStart = (events: readonly ConversationEvent[]): boolean =>
  events.length === 0 || (events[0] as ConversationEvent).seq === 1;

/** How many events a page of history reads (the first paint's last page, each earlier page). */
export const HISTORY_PAGE = 200;

/**
 * The turn-aligned page of events before `before` (`"end"`: the log's last page), with how many
 * runs started before its first event (history paging spec §2; an older kernel's answer has no
 * `turnsBefore`).
 */
export const listEventsBefore = (
  orgId: string,
  id: string,
  before: number | "end",
  limit = HISTORY_PAGE,
) =>
  apiFetch<{ events: ConversationEvent[]; turnsBefore?: number }>(
    `${one(orgId, id)}/events?before=${before}&limit=${limit}`,
  );

/** 读完 `after` 之后的全部事件（逐页）。 */
export async function listAllEvents(
  orgId: string,
  id: string,
  after = 0,
): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  let cursor = after;
  for (;;) {
    const { events } = await listEvents(orgId, id, cursor);
    out.push(...events);
    const last = events.at(-1);
    if (events.length < EVENTS_PAGE || last === undefined) return out;
    cursor = last.seq;
  }
}

/**
 * 发送用户消息（运行中发送即插话）：202 `{ event }`。`attachments`（`@` 资源引用）由内核以当前用户的凭据读取，
 * 作为附加文本块写入同一条消息；`files`（已 finalize 的上传附件 id）作为 image / document 引用块追加在最后。
 */
export const postMessage = (orgId: string, id: string, m: MessageInput) =>
  apiFetch<{ event: ConversationEvent }>(`${one(orgId, id)}/messages`, {
    method: "POST",
    body: JSON.stringify(messageBody(m)),
  });

/**
 * A message an older version queued (kernel `QueueItem`): not in the log until the kernel sends it
 * after a run. Nothing new is queued (run input spec 2026-11-07 D3); the web only lists leftovers.
 */
export interface QueueItem {
  id: string;
  text: string;
  files: { attachmentId: string; name: string; mediaType: string }[];
  attachments: { connectorId: string; name: string; uri: string }[];
  clientMessageId: string;
  /** The model / effort pick the message switches to when sent (null: none). */
  model: ModelRef | null;
  effort: string | null;
  createdAt: string;
  position: number;
  /** A queued skill invocation (phase D): `text` is its arguments. */
  skill?: { name: string; arguments: string; mode: "inline" | "fork" };
}

/** Why the queue paused (kernel `QueuePauseReason`; absent when not recorded). */
export type QueuePauseReason = "run_ended" | "author_cannot_send" | "skill_not_invocable";

export const listQueue = (orgId: string, id: string) =>
  apiFetch<{ items: QueueItem[]; paused: boolean; pauseReason?: QueuePauseReason }>(
    `${one(orgId, id)}/queue`,
  );

/** "Continue sending" after a pause. */
export const resumeQueue = (orgId: string, id: string) =>
  apiFetch<Record<string, never>>(`${one(orgId, id)}/queue/resume`, { method: "POST" });

/** Display metadata of a tool (kernel `ToolInfo`). */
export interface ToolInfo {
  key: string;
  /**
   * Set when `key` is an older name of a current tool (history logged before a rename): that
   * tool's key. The rest describes that tool; the page treats the call as a call to it.
   */
  aliasOf?: string;
  title: string | null;
  kind: "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";
  /** True exactly for the builtin tools that run in the conversation's sandbox. */
  sandbox: boolean;
  keyArgs: string[];
  /** A connector or extension tool's local name (`mcp__crm__delete` -> `delete`); else null. */
  tool: string | null;
  source:
    | { kind: "builtin" }
    | { kind: "extension"; name: string; displayName: { zh: string; en: string } }
    | { kind: "connector"; id: string; name: string }
    | { kind: "unknown" };
}

export const getToolInfo = (orgId: string, id: string, keys: readonly string[]) =>
  apiFetch<{ tools: ToolInfo[] }>(
    `${one(orgId, id)}/tools?keys=${keys.map(encodeURIComponent).join(",")}`,
  );
/** The parent conversation's sub-agents, newest first (owner only). */
export const listSubagents = (orgId: string, id: string, limit = 100) =>
  apiFetch<{ subagents: SubagentView[]; next: string | null }>(
    `${one(orgId, id)}/subagents?limit=${limit}`,
  );

/** The conversation's token usage, its sub-agents' included. */
export const getConversationUsage = (orgId: string, id: string) =>
  apiFetch<{ usage: ConversationUsage }>(`${one(orgId, id)}/usage`);

/**
 * One agent of a conversation tree (`GET …/agent-tree`, agent map spec §8): the root conversation
 * or a sub-agent at any depth. `idle`: no run is active and the latest one completed (or none ran).
 */
export interface AgentTreeNode {
  id: string;
  /** A sub-agent's dispatched description; the root's title ("" before it has one). */
  description: string;
  /** The sub-agent type; null for the root (and a sub-agent without one). */
  agentType: string | null;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" | "idle";
  model: ModelRef | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The wall time of its own runs (a running run up to now). */
  durationMs: number;
  /** The tokens of its own runs (never its descendants'). */
  tokens: number;
  toolCalls: number;
  /** The sub-agents it dispatched, oldest first. */
  children: AgentTreeNode[];
}

/** The agent tree of a root conversation (its owner only; 404 for a sub-agent conversation). */
export const getAgentTree = (orgId: string, id: string) =>
  apiFetch<{ root: AgentTreeNode }>(`${one(orgId, id)}/agent-tree`);

/** The conversation's background tasks and its sub-agents', newest first. */
export const listBackgroundTasks = (orgId: string, id: string) =>
  apiFetch<{ tasks: BackgroundTaskView[] }>(`${one(orgId, id)}/background-tasks`);

/** A person's stop: the task after it (`running` with `stopping` while the stop goes on). */
export const stopBackgroundTask = (orgId: string, id: string, taskId: string) =>
  apiFetch<{ task: BackgroundTaskView }>(
    `${one(orgId, id)}/background-tasks/${encodeURIComponent(taskId)}/stop`,
    { method: "POST" },
  );

/**
 * The end of a task's output; 409 `background_task.output_unavailable` when nothing is readable,
 * its `details[0]` saying why ({@link BackgroundTaskUnavailable}).
 */
export const readBackgroundTaskOutput = (orgId: string, id: string, taskId: string) =>
  apiFetch<BackgroundTaskOutput>(
    `${one(orgId, id)}/background-tasks/${encodeURIComponent(taskId)}/output`,
  );

/** 中止当前运行：202 `{ runId }`；没有活跃运行时内核返回 409 `run.not_active`。 */
export const abortRun = (orgId: string, id: string) =>
  apiFetch<{ runId: string }>(`${one(orgId, id)}/abort`, { method: "POST" });

/** 会话事件流的 URL（SSE，经同源代理）。 */
export const streamUrl = (orgId: string, id: string, after: number) =>
  `${one(orgId, id)}/stream?after=${after}`;

/** 工具输出存档的一页（内核按字符分页；`next` 为下一页的 offset，已到末尾为 null）。 */
export interface OutputPage {
  id: string;
  text: string;
  offset: number;
  totalChars: number;
  next: number | null;
}

/** 网页读存档时最多取的页数（每页至多 20 万字符），再多就只显示已取到的部分。 */
export const OUTPUT_MAX_PAGES = 5;

/**
 * 读工具输出存档的全文（`GET .../conversations/:id/outputs/:outputId`，逐页）：
 * 会话不可见 → `conversation.not_found`；存档不属于该会话或已过期 → `conversation.output_not_found`。
 * 超过 {@link OUTPUT_MAX_PAGES} 页时 `complete` 为 false。
 */
export async function readToolOutput(
  orgId: string,
  conversationId: string,
  outputId: string,
): Promise<{ text: string; complete: boolean }> {
  let text = "";
  let offset = 0;
  for (let page = 0; page < OUTPUT_MAX_PAGES; page++) {
    const q = offset === 0 ? "" : `?offset=${offset}`;
    const { output } = await apiFetch<{ output: OutputPage }>(
      `${one(orgId, conversationId)}/outputs/${encodeURIComponent(outputId)}${q}`,
    );
    text += output.text;
    if (output.next === null) return { text, complete: true };
    offset = output.next;
  }
  return { text, complete: false };
}

/** The size of an archived output (characters), from a one-character first page. */
export const toolOutputSize = (orgId: string, conversationId: string, outputId: string) =>
  apiFetch<{ output: OutputPage }>(
    `${one(orgId, conversationId)}/outputs/${encodeURIComponent(outputId)}?limit=1`,
  ).then((r) => r.output.totalChars);

/** A row action without a current org: AppFrame shows `shell.noCurrentOrg`. */
export class NoCurrentOrgError extends Error {
  constructor() {
    super("no current organization");
    this.name = "NoCurrentOrgError";
  }
}
