import {
  type FormAnswer,
  type Logger,
  normalizePlace,
  type UiActionResult,
  type UiBlock,
  type UiContribution,
  type UiIcon,
  type UiOpen,
  type UiView,
  validateUiView,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionHost, LoadedUiContribution } from "../extensions/host.js";
import type { OrgRole } from "../orgs/roles.js";
import { canUsePlace, isConversationPlace, UUID_RE } from "./registry.js";

/** 插件 render / action 的时限（spec §4.2：慢的插件只让那个标签失败）。 */
export const UI_CALL_TIMEOUT_MS = 5_000;

/** 列出贡献接口的一项。 */
export interface UiContributionItem {
  plugin: string;
  id: string;
  title: UiContribution["title"];
  /** Normalized: the old `conversation` is listed as `panel`. */
  place: Exclude<UiContribution["place"], "conversation" | "file-preview">;
  /** `"conversation"` when the manifest still says the old place. */
  legacyPlace?: "conversation";
  kind: UiContribution["kind"];
  /** 仅 embed：插件路由下 `/ui/` 开头的路径（网页经 `/plugin-ui/<plugin>/...` 代理访问）。 */
  path?: string;
  /** From `UI_ICONS`; `puzzle` when the manifest names none. */
  icon: UiIcon;
}

/** 嵌入应用的签发目标：已核对组织启用与对话访问。 */
export interface UiEmbedTarget {
  plugin: string;
  contribution: string;
  /** 清单里的 `path`（`/ui/` 开头）。 */
  path: string;
  conversationId?: string;
  /** Only a `file-preview` embed: the one file the token is for. */
  fileId?: string;
}

export interface UiViewsDeps {
  host: Pick<ExtensionHost, "uiContributions">;
  /** Names of the extensions enabled in the organization (`extension_org_configs.enabled` plus required bootstrap plugins, `enabled.ts`), queried every time, not cached. */
  enabledPlugins(orgId: string): Promise<Set<string>>;
  /** 调用者能否访问这个对话（与会话 SSE 流同一判定）。 */
  canAccessConversation(orgId: string, conversationId: string, accountId: string): Promise<boolean>;
  /**
   * Throws unless the caller may write to the conversation: a sub-agent's is read-only (409
   * `conversation.read_only`, sub-agents spec §6.1). Checked before an action (final review m3).
   */
  checkWritable?(orgId: string, conversationId: string, accountId: string): Promise<void>;
  /**
   * A `file-preview` embed token: whether that extension's previewer with `embed: contribution`
   * takes this file of the conversation (the viewer must read it; not found throws 404).
   */
  previewEmbedAllowed?(t: {
    orgId: string;
    accountId: string;
    conversationId: string;
    fileId: string;
    plugin: string;
    contribution: string;
  }): Promise<boolean>;
  /**
   * The `card` a `tool_result` of this conversation recorded for `callId` (`ToolResult.card`), or
   * null. An inline card request is served only when it matches (the card is attested by the log).
   */
  recordedCard?(
    conversationId: string,
    callId: string,
  ): Promise<{ plugin: string; view: string; key?: string } | null>;
  log: Pick<Logger, "warn">;
  /** 默认 {@link UI_CALL_TIMEOUT_MS}（测试可调小）。 */
  timeoutMs?: number;
}

/** 取视图 / 执行动作的调用者与目标（身份来自内核鉴权）。 */
export interface UiTarget {
  orgId: string;
  accountId: string;
  /** 调用者在 `orgId` 的角色（OrgGuard 查出的成员关系）。 */
  role: OrgRole;
  plugin: string;
  id: string;
  conversationId?: string;
  locale: "zh" | "en";
  /** A panel opened from an open target: the item to scroll to. */
  item?: string;
  /** An inline card: the tool call it hangs off and its `ToolResult.card.key`. */
  card?: { callId: string; key?: string };
}

/**
 * The card a `tool_result` of the conversation recorded for `callId`, or null (the inline-card
 * attestation of {@link UiViewsDeps.recordedCard}). Scans one conversation's tool results.
 */
export async function recordedCard(
  db: KernelSchemaDb,
  conversationId: string,
  callId: string,
): Promise<{ plugin: string; view: string; key?: string } | null> {
  const row = await db
    .selectFrom("conversation_events")
    .select(sql<unknown>`payload->'card'`.as("card"))
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "tool_result")
    .where(sql<string>`payload->>'callId'`, "=", callId)
    .where(sql<boolean>`payload ? 'card'`)
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  const c = row?.card as { plugin?: unknown; view?: unknown; key?: unknown } | null | undefined;
  if (!c || typeof c.plugin !== "string" || typeof c.view !== "string") return null;
  return { plugin: c.plugin, view: c.view, ...(typeof c.key === "string" && { key: c.key }) };
}

/**
 * Drops open targets that name no `panel` of the extension (design spec §6.16; review M6): the web
 * only opens listed panels of the same extension, and the kernel does not pass others on.
 */
export function dropForeignOpens(view: UiView, panels: ReadonlySet<string>): UiView {
  const ok = (o: UiOpen | null | undefined) => o != null && panels.has(o.contribution);
  const blocks = view.blocks.map((b): UiBlock => {
    if (b.type === "checklist" || b.type === "keyValue") {
      const items = b.items.map((it) => {
        if (it.open === undefined || ok(it.open)) return it;
        const { open: _drop, ...rest } = it;
        return rest;
      });
      return { ...b, items } as UiBlock;
    }
    if (b.type === "table" && b.open !== undefined) {
      return { ...b, open: b.open.map((o) => (ok(o) ? o : null)) };
    }
    return b;
  });
  const { open, ...rest } = view;
  return { ...rest, ...(open !== undefined && ok(open) && { open }), blocks };
}

const TOAST_MAX = 500;
const MAX_LOGGED_PROBLEMS = 10;

const notFound = () => new ApiError("ui.not_found", "UI contribution not found");

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 校验动作结果，返回问题列表（空 = 合法）。 */
function actionResultProblems(r: unknown): string[] {
  if (!isObj(r)) return ["action result must be an object"];
  if (r.view !== undefined) return validateUiView(r.view).map((p) => `view: ${p}`);
  if (r.toast === undefined) return [];
  if (!isObj(r.toast)) return ["toast must be an object with zh and en"];
  const out: string[] = [];
  for (const k of ["zh", "en"] as const) {
    const v = r.toast[k];
    if (typeof v !== "string" || v === "" || v.length > TOAST_MAX)
      out.push(`toast.${k} must be a non-empty string of at most ${TOAST_MAX} characters`);
  }
  return out;
}

/**
 * 插件视图（第一档：渲染 schema）：列出贡献、调用插件 `render` / `action`。
 * - 只认在该组织已启用、且已在本副本加载的插件（启用状态每次查库）；
 * - 对话视图要求调用者能访问这个对话（与 SSE 流一致），访问不了与不存在一样返回 404 `ui.not_found`；
 * - 组织页面（`place: "page"`，视图与嵌入）只给 member 以上：guest 列表里看不到、取视图 / 动作 / 令牌一律 404；
 * - 组织页面视图不接受 `conversationId`（带了 400，与对话视图缺它一致）；
 * - 调用带 5 秒时限与中止信号：render 抛错 502 `ui.render_failed`、action 抛错 502 `ui.action_failed`、
 *   超时 504 `ui.timeout`、返回非法视图 502
 *   `ui.invalid_view`，都记告警日志、不写对话日志（这些不是模型可见的内容）。
 * 不依赖 Nest；不保存跨请求状态。
 */
export class UiViews {
  private readonly timeoutMs: number;

  constructor(private readonly d: UiViewsDeps) {
    this.timeoutMs = d.timeoutMs ?? UI_CALL_TIMEOUT_MS;
  }

  /** 该组织、该角色可见的界面贡献：插件已启用且已加载；kind view 的要求插件注册了 render；组织页面要 member 以上。 */
  async contributions(orgId: string, role: OrgRole): Promise<UiContributionItem[]> {
    const all = this.d.host.uiContributions();
    if (all.length === 0) return [];
    const enabled = await this.d.enabledPlugins(orgId);
    return all
      .filter(
        (c) =>
          enabled.has(c.plugin) &&
          c.contribution.aliasOf === undefined &&
          c.contribution.place !== "file-preview" &&
          (c.contribution.kind === "embed" || c.render) &&
          canUsePlace(c.contribution.place, role),
      )
      .map(({ plugin, contribution: c }) => ({
        plugin,
        id: c.id,
        title: c.title,
        place: normalizePlace(c.place) as UiContributionItem["place"],
        ...(c.place === "conversation" && { legacyPlace: "conversation" as const }),
        kind: c.kind,
        ...(c.kind === "embed" && c.path !== undefined && { path: c.path }),
        icon: c.icon ?? "puzzle",
      }));
  }

  /**
   * 嵌入应用：核对贡献是 embed、插件在该组织启用；对话嵌入要求调用者能访问该对话（否则 404，与视图一致），
   * 组织页面不收 `conversationId`。返回签发令牌所需的目标（令牌由调用方签）。
   */
  async embed(t: Omit<UiTarget, "locale"> & { fileId?: string }): Promise<UiEmbedTarget> {
    const { fileId, ...target } = t;
    const { entry, args } = await this.resolve({ ...target, locale: "en" }, "embed");
    const path = entry.contribution.path;
    if (path === undefined) throw notFound();
    const preview = entry.contribution.place === "file-preview";
    if (preview !== (fileId !== undefined)) {
      throw new ApiError(
        "validation_failed",
        preview
          ? "fileId is required for a file-preview embed"
          : "fileId is only allowed for a file-preview embed",
      );
    }
    if (fileId !== undefined) {
      const allowed =
        this.d.previewEmbedAllowed !== undefined &&
        (await this.d.previewEmbedAllowed({
          orgId: t.orgId,
          accountId: t.accountId,
          conversationId: args.conversationId as string,
          fileId,
          plugin: t.plugin,
          contribution: t.id,
        }));
      if (!allowed) throw notFound();
    }
    return {
      plugin: t.plugin,
      contribution: t.id,
      path,
      ...(args.conversationId !== undefined && { conversationId: args.conversationId }),
      ...(fileId !== undefined && { fileId }),
    };
  }

  /** 取视图：调用插件 `render`，校验返回的视图。 */
  async render(t: UiTarget): Promise<UiView> {
    const { entry, args } = await this.resolve(t, "render");
    const render = entry.render as NonNullable<LoadedUiContribution["render"]>;
    const view = await this.call(t, "render", (signal) => render({ ...args, signal }));
    this.check(t, "render", validateUiView(view));
    return dropForeignOpens(view, this.panels(t.plugin));
  }

  /** 执行动作：调用插件 `action`（视图里的按钮 / 表单提交），校验返回的提示或新视图。 */
  async act(
    t: UiTarget,
    input: { actionId: string; payload?: unknown; answer?: FormAnswer },
  ): Promise<UiActionResult> {
    const { entry, args } = await this.resolve(t, "action");
    const action = entry.action as NonNullable<LoadedUiContribution["action"]>;
    const r = await this.call(t, "action", (signal) =>
      action({
        ...args,
        signal,
        actionId: input.actionId,
        ...(input.payload !== undefined && { payload: input.payload }),
        ...(input.answer !== undefined && { answer: input.answer }),
      }),
    );
    this.check(t, "action", actionResultProblems(r));
    const res = r as { view?: UiView; toast?: { zh: string; en: string } };
    if (res.view !== undefined) return { view: dropForeignOpens(res.view, this.panels(t.plugin)) };
    return res.toast !== undefined ? { toast: { zh: res.toast.zh, en: res.toast.en } } : {};
  }

  /** Ids of the extension's live `panel` contributions (aliases of panels included). */
  private panels(plugin: string): Set<string> {
    return new Set(
      this.d.host
        .uiContributions()
        .filter((c) => c.plugin === plugin && normalizePlace(c.contribution.place) === "panel")
        .map((c) => c.contribution.id),
    );
  }

  /** 找贡献、核对组织启用与对话访问；返回传给插件的参数（不含 signal）。 */
  private async resolve(
    t: UiTarget,
    need: "render" | "action" | "embed",
  ): Promise<{
    entry: LoadedUiContribution;
    args: {
      orgId: string;
      accountId: string;
      role: OrgRole;
      locale: UiTarget["locale"];
      conversationId?: string;
      item?: string;
      card?: { callId: string; key?: string };
    };
  }> {
    const loaded = this.d.host.uiContributions();
    const named = loaded.find((c) => c.plugin === t.plugin && c.contribution.id === t.id);
    // a retired alias answers with the contribution it names (same extension and kind)
    const aliasOf = named?.contribution.aliasOf;
    const id = aliasOf ?? t.id;
    const entry = loaded.find(
      (c) =>
        c.plugin === t.plugin &&
        c.contribution.id === id &&
        c.contribution.aliasOf === undefined &&
        (need === "embed"
          ? c.contribution.kind === "embed"
          : c.contribution.kind === "view" && c[need] !== undefined),
    );
    if (!entry || !canUsePlace(entry.contribution.place, t.role)) throw notFound();
    if (!(await this.d.enabledPlugins(t.orgId)).has(t.plugin)) throw notFound();
    const base = { orgId: t.orgId, accountId: t.accountId, role: t.role, locale: t.locale };
    if (!isConversationPlace(entry.contribution.place)) {
      if (t.item !== undefined || t.card !== undefined) {
        throw new ApiError("validation_failed", "item and callId are for conversation views");
      }
      if (t.conversationId !== undefined) {
        throw new ApiError(
          "validation_failed",
          `conversationId is not allowed for an organization page ${need === "embed" ? "embed" : "view"}`,
        );
      }
      return { entry, args: base };
    }
    const conversationId = t.conversationId;
    if (conversationId === undefined) {
      throw new ApiError(
        "validation_failed",
        `conversationId is required for a conversation ${need === "embed" ? "embed" : "view"}`,
      );
    }
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.d.canAccessConversation(t.orgId, conversationId, t.accountId))
    ) {
      throw notFound();
    }
    // an action is a person's write: a sub-agent's conversation takes none (views still render)
    if (need === "action") await this.d.checkWritable?.(t.orgId, conversationId, t.accountId);
    if (t.card !== undefined) {
      // args.card is attested: an inline view, and a tool_result of this conversation recorded this
      // very card (plugin, the requested id or its alias target, key); else it is not found
      const recorded =
        normalizePlace(entry.contribution.place) === "inline" && this.d.recordedCard !== undefined
          ? await this.d.recordedCard(conversationId, t.card.callId)
          : null;
      if (
        recorded === null ||
        recorded.plugin !== t.plugin ||
        (recorded.view !== t.id && recorded.view !== id) ||
        recorded.key !== t.card.key
      ) {
        throw notFound();
      }
    }
    return {
      entry,
      args: {
        ...base,
        conversationId,
        ...(t.item !== undefined && { item: t.item }),
        ...(t.card !== undefined && { card: t.card }),
      },
    };
  }

  /** 带时限调用插件：超时中止信号并 504；抛错 502（render / action 各一个码，不回显插件的异常信息）。 */
  private call<T>(
    t: UiTarget,
    what: "render" | "action",
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return callExtension({
      log: this.d.log,
      plugin: t.plugin,
      what,
      fields: { plugin: t.plugin, contribution: t.id, orgId: t.orgId },
      timeoutMs: this.timeoutMs,
      failCode: what === "render" ? "ui.render_failed" : "ui.action_failed",
      failMessage: `Plugin ${t.plugin} failed to ${what} ${t.id}`,
      fn,
    });
  }

  /** 非法结果：记告警（列出前几条问题）并 502 `ui.invalid_view`。 */
  private check(t: UiTarget, what: "render" | "action", problems: string[]): void {
    if (problems.length === 0) return;
    this.d.log.warn(`plugin ui ${what} returned an invalid view`, {
      plugin: t.plugin,
      contribution: t.id,
      orgId: t.orgId,
      problems: problems.slice(0, MAX_LOGGED_PROBLEMS),
    });
    throw new ApiError("ui.invalid_view", `Plugin ${t.plugin} returned an invalid view`);
  }
}

/**
 * Calls an extension with a time limit and an abort signal (plugin views, actions and file
 * previewers): over the limit the signal aborts and the call is 504 `ui.timeout`; a throw is
 * `failCode` (502) without echoing the extension's message. An `ApiError` thrown by `fn` passes.
 */
export async function callExtension<T>(o: {
  log: Pick<Logger, "warn">;
  plugin: string;
  what: string;
  fields: Record<string, unknown>;
  timeoutMs: number;
  failCode: "ui.render_failed" | "ui.action_failed";
  failMessage: string;
  fn: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error(`plugin ui ${o.what} timed out`));
      resolve("timeout");
    }, o.timeoutMs);
  });
  try {
    const r = await Promise.race([
      Promise.resolve()
        .then(() => o.fn(ac.signal))
        .then((value) => ({ value })),
      timeout,
    ]);
    if (r === "timeout") {
      o.log.warn(`plugin ui ${o.what} timed out`, { ...o.fields, timeoutMs: o.timeoutMs });
      throw new ApiError(
        "ui.timeout",
        `Plugin ${o.plugin} did not respond within ${o.timeoutMs / 1000}s`,
      );
    }
    return r.value;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    o.log.warn(`plugin ui ${o.what} failed`, { ...o.fields, err: e });
    throw new ApiError(o.failCode, o.failMessage);
  } finally {
    clearTimeout(timer);
  }
}
