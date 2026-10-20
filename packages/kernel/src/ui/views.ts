import {
  type FormAnswer,
  type Logger,
  type UiActionResult,
  type UiContribution,
  type UiView,
  validateUiView,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import type { LoadedUiContribution, PluginHost } from "../plugins/host.js";

/** 插件 render / action 的时限（spec §4.2：慢的插件只让那个标签失败）。 */
export const UI_CALL_TIMEOUT_MS = 5_000;

/** 列出贡献接口的一项。 */
export interface UiContributionItem {
  plugin: string;
  id: string;
  title: UiContribution["title"];
  place: UiContribution["place"];
  kind: UiContribution["kind"];
}

export interface UiViewsDeps {
  host: Pick<PluginHost, "uiContributions">;
  /** 在该组织启用的插件名（`plugin_org_configs.enabled`），每次查询、不缓存。 */
  enabledPlugins(orgId: string): Promise<Set<string>>;
  /** 调用者能否访问这个对话（与会话 SSE 流同一判定）。 */
  canAccessConversation(orgId: string, conversationId: string, accountId: string): Promise<boolean>;
  log: Pick<Logger, "warn">;
  /** 默认 {@link UI_CALL_TIMEOUT_MS}（测试可调小）。 */
  timeoutMs?: number;
}

/** 取视图 / 执行动作的调用者与目标（身份来自内核鉴权）。 */
export interface UiTarget {
  orgId: string;
  accountId: string;
  plugin: string;
  id: string;
  conversationId?: string;
  locale: "zh" | "en";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
 * - 调用带 5 秒时限与中止信号：抛错 502 `ui.render_failed`、超时 504 `ui.timeout`、返回非法视图 502
 *   `ui.invalid_view`，都记告警日志、不写对话日志（这些不是模型可见的内容）。
 * 不依赖 Nest；不保存跨请求状态。
 */
export class UiViews {
  private readonly timeoutMs: number;

  constructor(private readonly d: UiViewsDeps) {
    this.timeoutMs = d.timeoutMs ?? UI_CALL_TIMEOUT_MS;
  }

  /** 该组织可见的界面贡献：插件已启用且已加载；kind view 的要求插件注册了 render。 */
  async contributions(orgId: string): Promise<UiContributionItem[]> {
    const all = this.d.host.uiContributions();
    if (all.length === 0) return [];
    const enabled = await this.d.enabledPlugins(orgId);
    return all
      .filter((c) => enabled.has(c.plugin) && (c.contribution.kind === "embed" || c.render))
      .map(({ plugin, contribution: c }) => ({
        plugin,
        id: c.id,
        title: c.title,
        place: c.place,
        kind: c.kind,
      }));
  }

  /** 取视图：调用插件 `render`，校验返回的视图。 */
  async render(t: UiTarget): Promise<UiView> {
    const { entry, args } = await this.resolve(t, "render");
    const render = entry.render as NonNullable<LoadedUiContribution["render"]>;
    const view = await this.call(t, "render", (signal) => render({ ...args, signal }));
    this.check(t, "render", validateUiView(view));
    return view;
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
    if (res.view !== undefined) return { view: res.view };
    return res.toast !== undefined ? { toast: { zh: res.toast.zh, en: res.toast.en } } : {};
  }

  /** 找贡献、核对组织启用与对话访问；返回传给插件的参数（不含 signal）。 */
  private async resolve(t: UiTarget, need: "render" | "action") {
    const entry = this.d.host
      .uiContributions()
      .find(
        (c) =>
          c.plugin === t.plugin &&
          c.contribution.id === t.id &&
          c.contribution.kind === "view" &&
          c[need] !== undefined,
      );
    if (!entry || !(await this.d.enabledPlugins(t.orgId)).has(t.plugin)) throw notFound();
    const base = { orgId: t.orgId, accountId: t.accountId, locale: t.locale };
    if (entry.contribution.place !== "conversation") return { entry, args: base };
    const conversationId = t.conversationId;
    if (conversationId === undefined) {
      throw new ApiError("validation_failed", "conversationId is required for a conversation view");
    }
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.d.canAccessConversation(t.orgId, conversationId, t.accountId))
    ) {
      throw notFound();
    }
    return { entry, args: { ...base, conversationId } };
  }

  /** 带时限调用插件：超时中止信号并 504；抛错 502（不回显插件的异常信息）。 */
  private async call<T>(
    t: UiTarget,
    what: "render" | "action",
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        ac.abort(new Error(`plugin ui ${what} timed out`));
        resolve("timeout");
      }, this.timeoutMs);
    });
    const fields = { plugin: t.plugin, contribution: t.id, orgId: t.orgId };
    try {
      const r = await Promise.race([
        Promise.resolve()
          .then(() => fn(ac.signal))
          .then((value) => ({ value })),
        timeout,
      ]);
      if (r === "timeout") {
        this.d.log.warn(`plugin ui ${what} timed out`, { ...fields, timeoutMs: this.timeoutMs });
        throw new ApiError(
          "ui.timeout",
          `Plugin ${t.plugin} did not respond within ${this.timeoutMs / 1000}s`,
        );
      }
      return r.value;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      this.d.log.warn(`plugin ui ${what} failed`, { ...fields, err: e });
      throw new ApiError("ui.render_failed", `Plugin ${t.plugin} failed to ${what} ${t.id}`);
    } finally {
      clearTimeout(timer);
    }
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
