import { type FormAnswer, type InputForm, validateInputForm } from "./tool.js";
import { isHttpUrl } from "./url.js";

/**
 * 渠道中立的 IM 卡片：由内核定义与产出，渠道插件按各自 IM 的原生格式渲染；
 * 不支持卡片的渠道用 {@link renderCardAsText} 退回为文本。
 */
export type ChannelCard =
  | {
      kind: "approval";
      id: string;
      title: string;
      toolName: string;
      appName?: string;
      agentName: string;
      inputPreview: string;
      scopes: ("once" | "session" | "always")[];
      expiresAt: string;
      state: "pending" | "approved" | "denied" | "expired" | "cancelled";
      decidedBy?: string;
      /** 可决定该审批的会话网页链接。 */
      webUrl: string;
    }
  | {
      kind: "question";
      id: string;
      form: InputForm;
      state: "pending" | "answered" | "expired" | "cancelled";
      answerSummary?: string;
      webUrl: string;
    }
  | { kind: "connect"; appName: string; url: string }
  | { kind: "bind"; url: string; text: string };

/** 用户在 IM 卡片上的操作，由渠道插件解析后经入站事件交给内核。 */
export interface CardAction {
  cardKind: "approval" | "question";
  cardId: string;
  action: "approve" | "deny" | "answer";
  scope?: "once" | "session" | "always";
  answer?: FormAnswer;
}

/** 发往 IM 的一条消息：text 为 Markdown（渠道插件转换为原生富文本），可附卡片。 */
export interface OutboundMessage {
  text: string;
  cards?: ChannelCard[];
}

const MAX_INLINE_SINGLE = 5;
const MAX_INLINE_MULTI = 10;

/**
 * 提问能否在 IM 内直接作答：仅当表单恰有一个枚举字段（单选 ≤ 5 项 / 多选 ≤ 10 项）且不允许「其他」时为真；
 * 否则卡片只给网页链接。
 */
export function questionRenderableInline(form: InputForm): boolean {
  if (form.fields.length !== 1) return false;
  const f = form.fields[0];
  if (!f || f.allowOther) return false;
  if (f.schema.type !== "string" || !("enum" in f.schema)) return false;
  const n = f.schema.enum.length;
  return f.multiSelect ? n <= MAX_INLINE_MULTI : n <= MAX_INLINE_SINGLE;
}

const KINDS = ["approval", "question", "connect", "bind"] as const;
const SCOPES = ["once", "session", "always"] as const;
const APPROVAL_STATES = ["pending", "approved", "denied", "expired", "cancelled"] as const;
const QUESTION_STATES = ["pending", "answered", "expired", "cancelled"] as const;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const list = (xs: readonly string[]) => xs.map((x) => JSON.stringify(x)).join(", ");

/** 校验卡片结构，返回问题列表（空 = 合法）。 */
export function validateChannelCard(card: unknown): string[] {
  if (typeof card !== "object" || card === null || Array.isArray(card))
    return ["card must be an object"];
  const c = card as Record<string, unknown>;
  const out: string[] = [];
  const nonEmpty = (k: string) => {
    if (typeof c[k] !== "string" || c[k] === "") out.push(`${k} must be a non-empty string`);
  };
  const optNonEmpty = (k: string) => {
    if (c[k] !== undefined) nonEmpty(k);
  };
  const oneOf = (k: string, xs: readonly string[]) => {
    if (typeof c[k] !== "string" || !xs.includes(c[k] as string))
      out.push(`${k} must be one of ${list(xs)}`);
  };
  const url = (k: string) => {
    if (!isHttpUrl(c[k]))
      out.push(`${k} must be an absolute http(s) URL of at most 2000 characters`);
  };

  switch (c.kind) {
    case "approval": {
      for (const k of ["id", "title", "toolName", "agentName"]) nonEmpty(k);
      optNonEmpty("appName");
      if (typeof c.inputPreview !== "string") out.push("inputPreview must be a string");
      const s = c.scopes;
      if (
        !Array.isArray(s) ||
        s.length === 0 ||
        new Set(s).size !== s.length ||
        s.some((x) => !(SCOPES as readonly unknown[]).includes(x))
      )
        out.push(`scopes must be a non-empty array of ${list(SCOPES)} without duplicates`);
      if (
        typeof c.expiresAt !== "string" ||
        !ISO_8601.test(c.expiresAt) ||
        Number.isNaN(Date.parse(c.expiresAt))
      )
        out.push("expiresAt must be an ISO 8601 timestamp");
      oneOf("state", APPROVAL_STATES);
      optNonEmpty("decidedBy");
      url("webUrl");
      return out;
    }
    case "question": {
      nonEmpty("id");
      oneOf("state", QUESTION_STATES);
      url("webUrl");
      if (c.answerSummary !== undefined && typeof c.answerSummary !== "string")
        out.push("answerSummary must be a string");
      // 不能在 IM 内作答的表单（见 questionRenderableInline）同样合法：渠道只渲染网页链接。
      for (const p of validateInputForm(c.form as InputForm)) out.push(`form: ${p}`);
      return out;
    }
    case "connect":
      nonEmpty("appName");
      url("url");
      return out;
    case "bind":
      url("url");
      nonEmpty("text");
      return out;
    default:
      return [`kind must be one of ${list(KINDS)}`];
  }
}

type Locale = "zh" | "en";

const TEXT = {
  en: {
    sep: ": ",
    approval: "[Approval] ",
    question: "[Question] ",
    connect: (app: string) => `[Connect] ${app} needs to be connected.`,
    tool: "Tool",
    agent: "Agent",
    input: "Input",
    status: "Status",
    expires: "Expires",
    answer: "Answer",
    approveOnWeb: "Cards are not supported here. Approve or deny on the web",
    answerOnWeb: "Answer on the web",
    details: "Details",
    connectLink: "Connect",
    approvalStates: {
      pending: "Pending",
      approved: "Approved",
      denied: "Denied",
      expired: "Expired",
      cancelled: "Cancelled",
    },
    questionStates: {
      pending: "Pending",
      answered: "Answered",
      expired: "Expired",
      cancelled: "Cancelled",
    },
  },
  zh: {
    sep: "：",
    approval: "【审批】",
    question: "【提问】",
    connect: (app: string) => `【连接】需要连接 ${app}。`,
    tool: "工具",
    agent: "Agent",
    input: "输入",
    status: "状态",
    expires: "过期时间",
    answer: "回答",
    approveOnWeb: "此处不支持卡片，请到网页上批准或拒绝",
    answerOnWeb: "到网页上回答",
    details: "详情",
    connectLink: "连接",
    approvalStates: {
      pending: "待审批",
      approved: "已批准",
      denied: "已拒绝",
      expired: "已过期",
      cancelled: "已取消",
    },
    questionStates: {
      pending: "待回答",
      answered: "已回答",
      expired: "已过期",
      cancelled: "已取消",
    },
  },
} as const;

/** 不支持卡片的渠道的统一退回文本（含链接）；固定话术按 locale 取 zh / en。 */
export function renderCardAsText(card: ChannelCard, locale: Locale): string {
  const t = TEXT[locale] ?? TEXT.en;
  const line = (label: string, value: string) => `${label}${t.sep}${value}`;
  switch (card.kind) {
    case "approval": {
      const state = t.approvalStates[card.state];
      const lines = [
        `${t.approval}${card.title}`,
        line(t.tool, card.appName ? `${card.appName} / ${card.toolName}` : card.toolName),
        line(t.agent, card.agentName),
        line(t.input, card.inputPreview),
        line(t.status, card.decidedBy ? `${state} (${card.decidedBy})` : state),
      ];
      if (card.state === "pending")
        lines.push(line(t.expires, card.expiresAt), line(t.approveOnWeb, card.webUrl));
      else lines.push(line(t.details, card.webUrl));
      return lines.join("\n");
    }
    case "question": {
      const title = typeof card.form.title === "string" ? card.form.title : card.form.title[locale];
      const lines = [`${t.question}${title}`, line(t.status, t.questionStates[card.state])];
      if (card.answerSummary) lines.push(line(t.answer, card.answerSummary));
      lines.push(line(card.state === "pending" ? t.answerOnWeb : t.details, card.webUrl));
      return lines.join("\n");
    }
    case "connect":
      return `${t.connect(card.appName)}\n${line(t.connectLink, card.url)}`;
    case "bind":
      return `${card.text}\n${card.url}`;
  }
}
