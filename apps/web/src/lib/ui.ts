import { apiFetch } from "./api";
import type { FormAnswer, InputForm } from "./conversations";

/**
 * 插件界面（第一档：渲染 schema；第二档：嵌入应用的令牌）的类型与接口。
 * 类型照抄 `packages/plugin-sdk/src/ui.ts`（`UiBlock` / `UiView` / `UiContribution`）：Web 层只依赖 design，
 * 不 import SDK，SDK 改了这里要同步。接口见内核 `packages/kernel/src/ui/views.controller.ts`。
 */

export type UiPlace = "conversation" | "page";
export type UiKind = "view" | "embed";

/** `GET .../ui/contributions` 的一项（已启用、已加载的插件的界面贡献）。 */
export interface UiContributionItem {
  plugin: string;
  id: string;
  title: { zh: string; en: string };
  place: UiPlace;
  kind: UiKind;
  /** 仅 embed：插件路由下 `/ui/` 开头的路径。 */
  path?: string;
}

/** 嵌入令牌（`POST .../ui/embeds/:plugin/:id/token`）：`src` 是同源代理下的页面地址。 */
export interface EmbedToken {
  token: string;
  src: string;
  expiresAt: string;
}

export type UiBlock =
  | { type: "heading"; text: string }
  | { type: "text"; markdown: string }
  | {
      type: "checklist";
      items: { text: string; status: "pending" | "in_progress" | "completed" }[];
    }
  | { type: "keyValue"; items: { label: string; value: string }[] }
  | {
      type: "table";
      columns: { key: string; label: string }[];
      /** 每行按列 key 取单元格，可以缺列；读取一律用 {@link cellOf}（`Object.hasOwn`）。 */
      rows: Record<string, string>[];
    }
  | { type: "code"; language?: string; text: string }
  | { type: "image"; url: string; alt: string }
  | { type: "chart"; kind: "bar" | "line"; series: { label: string; value: number }[] }
  | {
      type: "actions";
      buttons: { actionId: string; label: string; payload?: unknown; danger?: boolean }[];
    }
  | { type: "form"; form: InputForm; actionId: string; submitLabel: string };

/** 插件视图：块列表；`badge` 显示在标签上（如「2/4」）。 */
export interface UiView {
  badge?: string;
  blocks: UiBlock[];
}

export type UiLocale = "zh" | "en";

/** 动作结果：一条提示，或一份新的视图（`{}` 表示什么都不做）。 */
export type UiActionResult = { toast?: { zh: string; en: string } } | { view: UiView };

/** 视图里的按钮或表单提交。 */
export interface UiActionRequest {
  actionId: string;
  payload?: unknown;
  answer?: FormAnswer;
}

/** SSE `event: ui` 帧：某个插件的某个贡献变了，去重新取。 */
export interface UiRefresh {
  plugin: string;
  contribution: string;
}

/** 刷新与取数状态里贡献的键。 */
export const uiKey = (plugin: string, id: string) => `${plugin}/${id}`;

/** 表格单元格：只认行对象自己的属性（列 key 可能是 `constructor` 之类，`row[key]` 会取到原型链）。 */
export const cellOf = (row: Record<string, string>, key: string): string =>
  Object.hasOwn(row, key) && typeof row[key] === "string" ? row[key] : "";

/** 只认 http(s) 绝对地址（内核已校验，网页再防一层）。 */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** UI 语言（next-intl 的 locale）→ 接口的 `locale`。 */
export const uiLocale = (locale: string): UiLocale => (locale === "zh" ? "zh" : "en");

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/ui`;
const target = (plugin: string, id: string) =>
  `${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;

export const listUiContributions = (orgId: string) =>
  apiFetch<{ items: UiContributionItem[] }>(`${base(orgId)}/contributions`);

/** 取视图：对话视图带 `conversationId`，组织页面不带。 */
export function getUiView(
  orgId: string,
  plugin: string,
  id: string,
  opts: { conversationId?: string; locale: UiLocale },
) {
  const q = new URLSearchParams();
  if (opts.conversationId !== undefined) q.set("conversationId", opts.conversationId);
  q.set("locale", opts.locale);
  return apiFetch<{ view: UiView }>(`${base(orgId)}/views/${target(plugin, id)}?${q}`);
}

export const postUiAction = (
  orgId: string,
  plugin: string,
  id: string,
  body: UiActionRequest & { conversationId?: string; locale: UiLocale },
) =>
  apiFetch<UiActionResult>(`${base(orgId)}/actions/${target(plugin, id)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** 取嵌入令牌：对话嵌入带 `conversationId`，组织页面不带。 */
export const requestEmbedToken = (
  orgId: string,
  plugin: string,
  id: string,
  opts: { conversationId?: string } = {},
) =>
  apiFetch<EmbedToken>(`${base(orgId)}/embeds/${target(plugin, id)}/token`, {
    method: "POST",
    body: JSON.stringify(
      opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {},
    ),
  });

/** 组织级刷新流的 URL（SSE，经同源代理）。 */
export const uiStreamUrl = (orgId: string) => `${base(orgId)}/stream`;

/** 解析 `event: ui` 帧的 data；形状不对返回 undefined。 */
export function parseUiRefresh(data: unknown): UiRefresh | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { plugin, contribution } = data as Record<string, unknown>;
  return typeof plugin === "string" && typeof contribution === "string"
    ? { plugin, contribution }
    : undefined;
}

/**
 * 打开组织级刷新流（组织页面视图用）：收到 `event: ui` 交给 `onUi`；断线由浏览器自动重连，
 * 每次重连成功后调用 `onReconnect`（期间可能漏掉刷新，调用方重取一次）。
 * 流终止、不会再重连时调用 `onError`：`code` 为服务端 `event: error` 帧的错误码（如会话被吊销），
 * 没有 `code` 表示浏览器放弃了重连。返回关闭函数。
 */
export function openUiStream(
  orgId: string,
  handlers: {
    onUi(r: UiRefresh): void;
    onReconnect?(): void;
    onError?(e: { code?: string }): void;
  },
): () => void {
  const es = new EventSource(uiStreamUrl(orgId));
  let closed = false;
  let opened = false;
  es.addEventListener("open", () => {
    if (closed) return;
    if (opened) handlers.onReconnect?.();
    opened = true;
  });
  es.addEventListener("ui", (e) => {
    if (closed || !(e instanceof MessageEvent) || typeof e.data !== "string") return;
    try {
      const r = parseUiRefresh(JSON.parse(e.data));
      if (r) handlers.onUi(r);
    } catch {
      // 非 JSON：忽略
    }
  });
  const close = () => {
    closed = true;
    es.close();
  };
  // 「error」既是服务端错误帧（MessageEvent，带 data），也是 EventSource 自身的连接错误（普通 Event）
  es.addEventListener("error", (e) => {
    if (closed) return;
    if (e instanceof MessageEvent && typeof e.data === "string") {
      let code: string | undefined;
      try {
        const d = JSON.parse(e.data) as { code?: unknown };
        if (typeof d.code === "string") code = d.code;
      } catch {
        // 非 JSON：按没有错误码处理
      }
      close();
      handlers.onError?.(code === undefined ? {} : { code });
      return;
    }
    // 仍在 CONNECTING：浏览器会自动重连
    if (es.readyState === 2) {
      close();
      handlers.onError?.({});
    }
  });
  return close;
}
