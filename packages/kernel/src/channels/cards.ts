import type { ChannelCard, FormAnswer, InputForm, OutboundMessage } from "@capybara-hq/plugin-sdk";
import type { KernelDb } from "../db/kernel-schema.js";
import type { ApprovalsService, ApprovalView } from "../tools/approvals.service.js";
import { KEY_SEPARATOR } from "../tools/naming.js";
import { type ChannelLocale, phrase } from "./phrases.js";

/** 审批卡片里工具参数预览的最大长度（字符）。 */
export const INPUT_PREVIEW_MAX = 500;

/** 打码后替换成的文本。 */
const MASK = "***";

/** 出现即视为凭据的整词。 */
const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "credential",
  "credentials",
  "cookie",
  "authorization",
  "apikey",
]);
/** 作为最后一个词时视为凭据（`access_token`、`authToken`；`max_tokens`、`token_count` 不算）。 */
const SECRET_LAST_WORDS = new Set(["token", "secret", "password"]);
/** 与 `key` / `id` 相邻构成凭据的前一个词（`api_key`、`private-key`、`session_id`）。 */
const KEY_PREFIXES = new Set(["api", "access", "private", "secret", "signing", "client"]);

/** 参数名拆成小写单词：驼峰与 `_` `-` `.` 空格都是分隔。 */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/**
 * 看起来是凭据的参数名（按整词判断，避免误伤 `max_tokens` 这类键）：其值在 IM 卡片里打码。
 * 工具参数由模型生成，内核没有「本次注入的凭据」可比对（那是工具结果的打码方式，见 tools/redact.ts），
 * 这里按键名兜底，再由调用方按连接密钥的值打码——IM 消息会留在第三方平台上。
 */
export function isSecretKey(key: string): boolean {
  const ws = words(key);
  const last = ws[ws.length - 1];
  if (ws.some((w) => SECRET_WORDS.has(w))) return true;
  if (last !== undefined && SECRET_LAST_WORDS.has(last)) return true;
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i] as string;
    const prev = ws[i - 1] as string;
    if (w === "key" && KEY_PREFIXES.has(prev)) return true;
    if (w === "id" && prev === "session") return true;
  }
  return false;
}

/** 递归复制，键名像凭据的值替换为 `***`。 */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isSecretKey(k) ? MASK : maskSecrets(v);
    return out;
  }
  return value;
}

/**
 * 工具参数预览：凭据样式的键打码后序列化为 JSON，再经 `redact`（连接密钥的按值打码）处理，
 * 截断到 {@link INPUT_PREVIEW_MAX} 字符（含省略号）。
 */
export function inputPreview(input: unknown, redact: (s: string) => string = (s) => s): string {
  let s: string;
  try {
    s = redact(JSON.stringify(maskSecrets(input ?? {})) ?? "");
  } catch {
    s = "";
  }
  return s.length <= INPUT_PREVIEW_MAX ? s : `${s.slice(0, INPUT_PREVIEW_MAX - 1)}…`;
}

/** 去掉末尾斜杠的 `http.publicUrl`；未配置返回 undefined。 */
export function webBase(publicUrl: string | undefined): string | undefined {
  return publicUrl ? publicUrl.replace(/\/+$/, "") : undefined;
}

/** 会话的网页链接（与审批详情的 `conversationPath` 一致：`/chat/<id>`，不含语言前缀）。 */
export const conversationUrl = (base: string, conversationId: string) =>
  `${base}/chat/${conversationId}`;

/** 个人连接页里某个应用的位置（与网页 ConnectCard 的链接一致）。 */
export const connectUrl = (base: string, appId: string) =>
  `${base}/settings/connections#app-${encodeURIComponent(appId)}`;

/** 来源内的工具名：应用工具去掉 `<slug>__`（审批详情已处理），插件工具去掉 `<插件>__`。 */
function shortToolName(v: ApprovalView): string {
  if (v.app) return v.toolName;
  const i = v.toolKey.indexOf(KEY_SEPARATOR);
  return i > 0 ? v.toolKey.slice(i + KEY_SEPARATOR.length) : v.toolKey;
}

export interface CardDeps {
  db: KernelDb;
  approvals: Pick<ApprovalsService, "describe">;
}

/** 账号显示名；不存在返回 undefined。 */
async function displayName(db: KernelDb, accountId: string | null): Promise<string | undefined> {
  if (accountId === null) return undefined;
  const r = await db
    .selectFrom("accounts")
    .select("display_name")
    .where("id", "=", accountId)
    .executeTakeFirst();
  return r?.display_name || undefined;
}

/**
 * 审批卡片（按审批的当前状态）；审批不存在返回 undefined。按角色升级的审批只能「仅此一次」。
 * `webUrl` = `http.publicUrl` + 会话路径。
 */
export async function approvalCard(
  d: CardDeps,
  approvalId: string,
  base: string,
  locale: ChannelLocale,
  redact?: (s: string) => string,
): Promise<Extract<ChannelCard, { kind: "approval" }> | undefined> {
  const v = await d.approvals.describe(approvalId);
  if (!v) return undefined;
  const decidedBy = await displayName(d.db, v.decidedBy);
  return {
    kind: "approval",
    id: v.id,
    title: phrase("approvalTitle", locale),
    toolName: shortToolName(v),
    ...(v.app && { appName: v.app.name }),
    agentName: v.agent.name || "Agent",
    inputPreview: inputPreview(v.input, redact),
    scopes: v.requestedFor === null ? ["once"] : ["once", "session", "always"],
    expiresAt: v.expiresAt,
    state: v.status,
    ...(decidedBy !== undefined && { decidedBy }),
    webUrl: `${base}${v.conversationPath}`,
  };
}

/** 答案摘要：每个字段的值（多选用逗号连接），多个字段用分号分隔。 */
export function answerSummary(answer: FormAnswer | null): string | undefined {
  if (answer === null) return undefined;
  const parts = Object.values(answer).map((v) => (Array.isArray(v) ? v.join(", ") : String(v)));
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** 提问卡片。不能在 IM 内作答的表单（`questionRenderableInline` 为 false）由渠道只渲染网页链接。 */
export function questionCard(
  questionId: string,
  form: InputForm,
  state: "pending" | "answered" | "expired" | "cancelled",
  webUrl: string,
  answer: FormAnswer | null = null,
): Extract<ChannelCard, { kind: "question" }> {
  const summary = answerSummary(answer);
  return {
    kind: "question",
    id: questionId,
    form,
    state,
    ...(summary !== undefined && { answerSummary: summary }),
    webUrl,
  };
}

/** 一条只带一张卡片的消息（随附文本为固定话术）。 */
export const cardMessage = (text: string, card: ChannelCard): OutboundMessage => ({
  text,
  cards: [card],
});
