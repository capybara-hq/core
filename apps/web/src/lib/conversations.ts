import { apiFetch } from "./api";

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
export type ApprovalPolicy = "agent" | "connector" | "default" | "role" | "org" | "fixed";

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
  | { kind: "read"; path: string; fromLine?: number; toLine?: number };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other" | "aborted";

type EventBody =
  | {
      type: "user_message";
      payload: {
        content: ContentBlock[];
        /** `@` 资源引用的附件：第 i 个附件的正文是 `content[i + 1]`。 */
        attachments?: MessageAttachment[];
        authorAccountId: string;
        clientMessageId?: string;
        /** A retry after a failed run: the seq of the message it repeats (display only). */
        retryOf?: number;
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
  | { type: "run_started"; payload: { agentVersion: number; model: ModelRef } }
  | { type: "model_call"; payload: { step: number; provider: string; model: string } }
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
        /** `compaction`: the usage of a compaction call, not of the step's call. */
        purpose?: "compaction" | "title";
      };
    }
  | { type: "reminder"; payload: { step: number; text: string } }
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
      };
    }
  | {
      type: "approval_decided";
      payload: {
        approvalId: string;
        callId: string;
        decision: "approved" | "denied" | "expired" | "cancelled";
        scope?: "once" | "session" | "always";
        byAccountId: string | null;
        /** The reason given with a denial. */
        reason?: string;
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
        outcome: "answered" | "expired" | "cancelled";
      };
    }
  | {
      /** agent 经 `sandbox_deliver` 交付的文件（产物）：字节在对象存储，经 artifacts 下载接口取。 */
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
        definition: { name: string; tools?: SubagentToolRef[]; [key: string]: unknown };
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
      };
    }
  /** Parent log: a sub-agent waits for a person (its approval, question or connection). */
  | {
      type: "subagent_waiting";
      payload: {
        subagentId: string;
        childRunId: string;
        kind: "approval" | "input" | "connect";
        approvalId?: string;
        questionId?: string;
        toolKey: string;
        expiresAt?: string;
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

/** How a sub-agent's run ended (`subagent_finished.status`). */
export type SubagentEndStatus =
  | "completed"
  | "max_steps"
  | "max_duration"
  | "budget"
  | "aborted"
  | "timed_out"
  | "failed";

/** A tool reference in a sub-agent's frozen definition (only what the child view shows). */
export type SubagentToolRef =
  | { kind: "builtin"; name: string }
  | { kind: "plugin"; plugin: string; name: string }
  | { kind: "connector"; connectorId: string; tools: "all" | string[] };

/** Token usage summed over events (`GET .../usage`, a `subagent_finished`). */
export interface ConversationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 已写入日志的会话事件。 */
export type ConversationEvent = EventBody & {
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

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations`;
const one = (orgId: string, id: string) => `${base(orgId)}/${encodeURIComponent(id)}`;

/** 每页事件上限（内核 `limit` 的最大值）。 */
export const EVENTS_PAGE = 500;

export const createConversation = (orgId: string, agentId: string) =>
  apiFetch<{ conversation: Conversation }>(base(orgId), {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });

/** What a message carries besides its text (`POST …/messages`, the first message, the queue). */
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
}

const messageBody = (m: MessageInput) => ({
  text: m.text,
  clientMessageId: m.clientMessageId,
  ...(m.attachments !== undefined && m.attachments.length > 0 && { attachments: m.attachments }),
  ...(m.files !== undefined && m.files.length > 0 && { files: m.files }),
  ...(m.model !== undefined && { model: m.model }),
  ...(m.effort !== undefined && { effort: m.effort }),
  ...(m.retryOf !== undefined && { retryOf: m.retryOf }),
});

/**
 * Create on first send: the conversation and its first message in one call. A retry with the same
 * `clientMessageId` returns the same conversation.
 */
export const createConversationWithMessage = (
  orgId: string,
  agentId: string,
  message: Omit<MessageInput, "retryOf">,
) =>
  apiFetch<{ conversation: Conversation; event: ConversationEvent }>(base(orgId), {
    method: "POST",
    body: JSON.stringify({ agentId, message: messageBody(message) }),
  });

/** Rename (owner only): a manual title is never regenerated. */
export const renameConversation = (orgId: string, id: string, title: string) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });

/** One agent's group of my conversations (`GET .../conversations/groups`, the sidebar). */
export interface ConversationGroup {
  agent: { id: string; name: string };
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
 * My conversations grouped by agent, by latest activity; `next` is passed back as `after`.
 *
 * The cursor is the last group's agent id, re-read at that group's latest activity when the next
 * page is asked for: a group that gets new activity between two pages can come back on the next
 * page (and one that moved up is skipped until a reload). Callers merge pages by agent id
 * (`useConversationGroups`).
 */
export const listConversationGroups = (
  orgId: string,
  opts: { perGroup?: number; limit?: number; after?: string } = {},
) =>
  apiFetch<{ groups: ConversationGroup[]; next: string | null }>(
    `${base(orgId)}/groups${query({ perGroup: opts.perGroup, limit: opts.limit, after: opts.after })}`,
  );

/** My conversations, newest first; `agentId` keeps one agent's (a group's "More"). */
export const listConversations = (
  orgId: string,
  opts: { agentId?: string; after?: string; limit?: number } = {},
) =>
  apiFetch<{ conversations: Conversation[]; next: string | null }>(
    `${base(orgId)}${query({ agentId: opts.agentId, after: opts.after, limit: opts.limit })}`,
  );

export const getConversation = (orgId: string, id: string) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id));

export const listEvents = (orgId: string, id: string, after: number, limit = EVENTS_PAGE) =>
  apiFetch<{ events: ConversationEvent[] }>(
    `${one(orgId, id)}/events?after=${after}&limit=${limit}`,
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

/** A queued message (kernel `QueueItem`): not in the log until it is sent. */
export interface QueueItem {
  id: string;
  text: string;
  files: { attachmentId: string; name: string; mediaType: string }[];
  attachments: { connectorId: string; name: string; uri: string }[];
  clientMessageId: string;
  createdAt: string;
  position: number;
}

export const listQueue = (orgId: string, id: string) =>
  apiFetch<{ items: QueueItem[]; paused: boolean }>(`${one(orgId, id)}/queue`);

/** Queues a message (⌘↵ while running); an idle conversation sends it at once (`event`). */
export const enqueueMessage = (
  orgId: string,
  id: string,
  m: Omit<MessageInput, "model" | "effort" | "retryOf">,
) =>
  apiFetch<{ item: QueueItem | null; event?: ConversationEvent }>(`${one(orgId, id)}/queue`, {
    method: "POST",
    body: JSON.stringify(messageBody(m)),
  });

export const editQueued = (orgId: string, id: string, itemId: string, text: string) =>
  apiFetch<{ item: QueueItem }>(`${one(orgId, id)}/queue/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });

export const deleteQueued = (orgId: string, id: string, itemId: string) =>
  apiFetch<void>(`${one(orgId, id)}/queue/${encodeURIComponent(itemId)}`, { method: "DELETE" });

/** "Send now": the queued message becomes an interjection. */
export const sendQueuedNow = (orgId: string, id: string, itemId: string) =>
  apiFetch<{ event: ConversationEvent }>(
    `${one(orgId, id)}/queue/${encodeURIComponent(itemId)}/send`,
    { method: "POST" },
  );

/** "Continue sending" after a pause. */
export const resumeQueue = (orgId: string, id: string) =>
  apiFetch<Record<string, never>>(`${one(orgId, id)}/queue/resume`, { method: "POST" });

/** Display metadata of a tool (kernel `ToolInfo`). */
export interface ToolInfo {
  key: string;
  title: string | null;
  kind: "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";
  keyArgs: string[];
  source:
    | { kind: "builtin" }
    | { kind: "extension"; name: string }
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

/** Fired on `window` when the sidebar's conversation list should reload (a title changed). */
export const CONVERSATIONS_CHANGED = "cap:conversations-changed";
export const notifyConversationsChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
};
