import {
  type ChannelCard,
  type FormAnswer,
  type InputForm,
  type OutboundMessage,
  parseToolKey,
} from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type {
  ApprovalsService,
  ApprovalView,
  GitAskView,
  NetworkAskView,
} from "../tools/approvals.service.js";
import { type ToolInfo, toolInfo } from "../tools/info.js";
import type { ToolRegistry } from "../tools/registry.js";
import { type ChannelLocale, phrase } from "./phrases.js";

/** The longest call line of an approval card (characters, the ellipsis included). */
export const CARD_SUMMARY_MAX = 300;

/** The longest key argument quoted in a call line without a summary (its first line). */
export const KEY_ARG_MAX = 120;

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

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const firstLine = (s: string) =>
  s
    .split(/\r?\n/)
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

const valueText = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
};

/**
 * The key argument of a call, as the web's tool row picks it: the first declared key argument
 * present, else the first string input other than `description`. Credential-like keys are skipped
 * (see {@link isSecretKey}); the value's first line, cut to {@link KEY_ARG_MAX}.
 */
export function keyArgument(input: unknown, keyArgs: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  // a structured value is shown as compact JSON with nested credential-like keys masked
  const pick = (v: unknown) => {
    const line = firstLine(valueText(maskSecrets(v)));
    return line === "" ? undefined : cut(line, KEY_ARG_MAX);
  };
  for (const k of keyArgs) {
    if (Object.hasOwn(rec, k) && rec[k] !== undefined && !isSecretKey(k)) {
      const v = pick(rec[k]);
      if (v !== undefined) return v;
    }
  }
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string" && k !== "description" && !isSecretKey(k)) {
      const line = pick(v);
      if (line !== undefined) return line;
    }
  }
  return undefined;
}

/**
 * The approval card's one line about the call (maintainer decision 2026-11-08: what the web
 * shows, never the raw input, which may hold a whole prompt and is seen by everyone in a group):
 * the kernel-rendered summary in the card's language (Platform operations, per-call policies),
 * else the tool's declared title and key argument (`Title: arg`, either alone), else "". Redacted
 * by `redact` (the connection's secret values), cut to {@link CARD_SUMMARY_MAX}. The full input is
 * behind the card's web link.
 */
export function callSummary(
  v: Pick<ApprovalView, "summary" | "input">,
  display: Pick<ToolInfo, "title" | "keyArgs"> | undefined,
  locale: ChannelLocale,
  redact: (s: string) => string = (s) => s,
): string {
  let line: string;
  if (v.summary !== null) {
    line = v.summary[locale];
  } else {
    const title = display?.title?.trim() || undefined;
    const arg = keyArgument(v.input, display?.keyArgs ?? []);
    line = title !== undefined && arg !== undefined ? `${title}: ${arg}` : (title ?? arg ?? "");
  }
  return cut(redact(line), CARD_SUMMARY_MAX);
}

/** 去掉末尾斜杠的 `http.publicUrl`；未配置返回 undefined。 */
export function webBase(publicUrl: string | undefined): string | undefined {
  return publicUrl ? publicUrl.replace(/\/+$/, "") : undefined;
}

/** 会话的网页链接（与审批详情的 `conversationPath` 一致：`/chat/<id>`，不含语言前缀）。 */
export const conversationUrl = (base: string, conversationId: string) =>
  `${base}/chat/${conversationId}`;

/** 个人连接页里某个连接器的位置（与网页 ConnectCard 的链接一致）。 */
export const connectUrl = (base: string, connectorId: string) =>
  `${base}/account/connections#connector-${encodeURIComponent(connectorId)}`;

const PLATFORM_KEY_PREFIX = "Platform:";

/**
 * The tool as the card names it (tool naming spec §7): a builtin by its name; a connector or
 * extension tool as `<display name> [<tool>]` (the connector's name, the plugin's display name in
 * the card's language), the way the web labels it.
 */
export function approvalToolName(
  v: Pick<ApprovalView, "toolKey" | "toolName" | "connector" | "extension">,
  locale: ChannelLocale,
): string {
  // a Platform call is keyed `Platform:<operation>`: the label names the operation
  if (v.toolKey.startsWith(PLATFORM_KEY_PREFIX)) {
    return `Platform [${v.toolKey.slice(PLATFORM_KEY_PREFIX.length)}]`;
  }
  // `toolName` is already the connector's own name for its tool
  if (v.connector) return `${v.connector.name} [${v.toolName}]`;
  const parsed = parseToolKey(v.toolKey);
  const tool = parsed && parsed.kind !== "builtin" ? parsed.tool : v.toolName;
  if (v.extension) return `${v.extension.displayName[locale]} [${tool}]`;
  return v.toolKey;
}

export interface CardDeps {
  db: KernelSchemaDb;
  approvals: Pick<ApprovalsService, "describe">;
  /** The tools' display metadata (title, key arguments) for a call without a summary. */
  registry: Pick<ToolRegistry, "builtinSpecs" | "extensionToolSpecs">;
}

/** 账号显示名；不存在返回 undefined。 */
async function displayName(
  db: KernelSchemaDb,
  accountId: string | null,
): Promise<string | undefined> {
  if (accountId === null) return undefined;
  const r = await db
    .selectFrom("accounts")
    .select("display_name")
    .where("id", "=", accountId)
    .executeTakeFirst();
  return r?.display_name || undefined;
}

/** What a network ask's card shows instead of a tool call (network ask-to-allow spec §6.4, §6.5). */
export interface NetworkCardText {
  title: string;
  inputPreview: string;
  scopeLabels: Partial<Record<"once" | "always", string>>;
}

/**
 * A network ask's card text: the title names the host (or the number of hosts); the preview lists
 * the hosts, then the command clipped to {@link CARD_SUMMARY_MAX} and, for several hosts, that the
 * decision applies to all of them (an IM card has no per-host choice). Model-controlled values
 * are redacted by `redact` (the connection's secret values); the description stays on the web.
 */
export function networkCardText(
  detail: Pick<NetworkAskView, "hosts" | "command">,
  locale: ChannelLocale,
  redact: (s: string) => string = (s) => s,
): NetworkCardText {
  const hosts = [...new Set(detail.hosts.map((h) => redact(h.host)))];
  const title =
    hosts.length === 1
      ? phrase("networkTitleOne", locale).replace("{host}", hosts[0] as string)
      : phrase("networkTitleMany", locale).replace("{n}", String(hosts.length));
  const command = cut(redact(detail.command.trim()), CARD_SUMMARY_MAX);
  return {
    title,
    inputPreview: [
      ...hosts,
      ...(command !== "" ? ["", command] : []),
      ...(hosts.length > 1 ? ["", phrase("networkAllHosts", locale)] : []),
    ].join("\n"),
    scopeLabels: {
      once: phrase("networkAllowOnce", locale),
      always: phrase("networkAllowAlways", locale),
    },
  };
}

/**
 * A git push ask's card text (sandbox git credentials spec §7): the title names the repository;
 * the preview is `<host>/<repo>`, the refs (`refs/heads/` dropped) and the command clipped to
 * {@link CARD_SUMMARY_MAX}. Model-controlled values are redacted by `redact`.
 */
export function gitCardText(
  detail: Pick<GitAskView, "host" | "repo" | "refs" | "command">,
  locale: ChannelLocale,
  redact: (s: string) => string = (s) => s,
): NetworkCardText {
  const repo = redact(detail.repo);
  const refs = detail.refs.map((r) => redact(r.replace(/^refs\/heads\//, "")));
  const command = cut(redact((detail.command ?? "").trim()), CARD_SUMMARY_MAX);
  return {
    title: phrase("gitTitle", locale).replace("{repo}", repo),
    inputPreview: [
      `${redact(detail.host)}/${repo}`,
      ...(refs.length > 0 ? [refs.join(", ")] : []),
      ...(command !== "" ? ["", command] : []),
    ].join("\n"),
    scopeLabels: {
      once: phrase("gitAllowOnce", locale),
      always: phrase("gitAllowAlways", locale),
    },
  };
}

/**
 * The approval card in the approval's current state; undefined when the approval does not exist.
 * A role escalation offers only "once". A network ask names its hosts and command and labels its
 * scopes ({@link networkCardText}). `webUrl` = `http.publicUrl` + the conversation path.
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
  // a network or git ask names what it asks about instead of a tool call (same card shape)
  const network =
    v.kind === "network" && v.detail !== null
      ? networkCardText(v.detail, locale, redact)
      : v.kind === "git" && v.git != null
        ? gitCardText(v.git, locale, redact)
        : null;
  const display =
    v.summary === null && network === null
      ? (await toolInfo({ db: d.db, registry: d.registry }, v.orgId, [v.toolKey]))[0]
      : undefined;
  return {
    kind: "approval",
    id: v.id,
    title: network?.title ?? phrase("approvalTitle", locale),
    // the label carries the source, so no separate appName (renderers would repeat it); a
    // network ask's command ran in Bash
    toolName: network !== null ? "Bash" : approvalToolName(v, locale),
    agentName: v.agent.name || "Agent",
    // the field keeps its contract name; it carries the call line (a network ask's hosts and
    // command), never the raw input
    inputPreview: network?.inputPreview ?? callSummary(v, display, locale, redact),
    // the scopes the approval allows (the kernel stores them for per-call policies)
    scopes: v.scopes,
    // the labels of the scopes offered only
    ...(network !== null && {
      scopeLabels: Object.fromEntries(
        Object.entries(network.scopeLabels).filter(([k]) => (v.scopes as string[]).includes(k)),
      ),
    }),
    expiresAt: v.expiresAt,
    state: v.status,
    ...(decidedBy !== undefined && { decidedBy }),
    // a denial's reason, as the web shows it (UI refresh B); redacted like the input
    ...(v.status === "denied" &&
      v.denyReason !== null &&
      v.denyReason !== "" && { denyReason: redact ? redact(v.denyReason) : v.denyReason }),
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
  state: Extract<ChannelCard, { kind: "question" }>["state"],
  webUrl: string,
  answer: FormAnswer | null = null,
  /** A pending card of the delivered conversation's own run: a text reply also works (§10.2). */
  textReply?: "plain" | "mention",
): Extract<ChannelCard, { kind: "question" }> {
  const summary = answerSummary(answer);
  return {
    kind: "question",
    id: questionId,
    form,
    state,
    ...(summary !== undefined && { answerSummary: summary }),
    webUrl,
    ...(state === "pending" && textReply !== undefined && { textReply }),
  };
}

/** 一条只带一张卡片的消息（随附文本为固定话术）。 */
export const cardMessage = (text: string, card: ChannelCard): OutboundMessage => ({
  text,
  cards: [card],
});
