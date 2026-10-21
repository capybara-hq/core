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

/** 用户消息附带的资源（内核读取正文，这里只有元数据）。 */
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
  | { type: "compaction_summary"; payload: { coversUpToSeq: number; text: string } }
  | { type: "compaction_failed"; payload: { attempt: number; reason: string } }
  | {
      type: "media_excluded";
      payload: { attachmentIds: string[]; reason: "provider_rejected" };
    }
  | { type: "run_finished"; payload: { reason: string; consumedUpToSeq: number } }
  | { type: "run_failed"; payload: { error: { code: string; message: string } } }
  | { type: "run_aborted"; payload: { byAccountId: string | null; reason: string } };

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

export interface Conversation {
  id: string;
  orgId: string;
  agentId: string;
  title: string | null;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
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
export const postMessage = (
  orgId: string,
  id: string,
  text: string,
  clientMessageId: string,
  attachments: { appId: string; uri: string }[] = [],
  files: string[] = [],
) =>
  apiFetch<{ event: ConversationEvent }>(`${one(orgId, id)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      text,
      clientMessageId,
      ...(attachments.length > 0 && { attachments }),
      ...(files.length > 0 && { files }),
    }),
  });

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
