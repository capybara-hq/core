import type {
  PluginManifest,
  UiActionArgs,
  UiActionResult,
  UiRenderArgs,
  UiView,
} from "@capybara-hq/plugin-sdk";

/** 插件视图的 render 函数（`ctx.ui.view` 注册）。 */
export type UiRender = (args: UiRenderArgs) => Promise<UiView>;
/** 插件视图的动作处理函数（`ctx.ui.action` 注册）。 */
export type UiActionHandler = (args: UiActionArgs) => Promise<UiActionResult>;

/**
 * 组织级界面刷新的内核 bus 主题（命名空间 `kernel`）：`org-ui.<orgId>`。
 * 对话视图的刷新走会话主题 `conv.<id>`（与事件、增量共用），见 `conversationTopic`。
 */
export const orgUiTopic = (orgId: string): string => `org-ui.${orgId}`;

/** 界面刷新消息：`conv.<id>` 与 `org-ui.<orgId>` 上的 `{ kind: "ui", plugin, contribution }`。 */
export interface UiBusMessage {
  kind: "ui";
  plugin: string;
  contribution: string;
}

/** 是否为界面刷新消息（bus 上的消息来自其他副本，按形状核对）。 */
export function isUiBusMessage(m: unknown): m is UiBusMessage {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.kind === "ui" && typeof x.plugin === "string" && typeof x.contribution === "string";
}

/** SSE 帧 `event: ui`，数据 `{ plugin, contribution }`。 */
export const uiFrame = (m: UiBusMessage): string =>
  `event: ui\ndata: ${JSON.stringify({ plugin: m.plugin, contribution: m.contribution })}\n\n`;

/**
 * 单个插件在 setup 期间注册的视图与动作：进程内的静态登记（同 `ctx.tools.register`），
 * 不是跨请求的共享状态——各副本加载同一插件得到同样的登记。
 * id 必须是 `permissions.ui.views` 里的（与清单 `ui` 里 kind view 的贡献一一对应，`definePlugin` 已交叉核对）。
 */
export class PluginUiRegistration {
  readonly views = new Map<string, UiRender>();
  readonly actions = new Map<string, UiActionHandler>();
  private readonly declaredViews: Set<string>;
  private readonly contributions: Set<string>;
  private sealed = false;

  constructor(
    private readonly manifest: PluginManifest,
    /** 越权（id 未在 `permissions.ui.views` 声明）：抛 PluginPermissionError 并写审计。 */
    private readonly deny: (item: string) => never,
  ) {
    this.declaredViews = new Set(manifest.permissions?.ui?.views ?? []);
    this.contributions = new Set((manifest.ui ?? []).map((c) => c.id));
  }

  /** setup 结束后调用：此后 view / action 抛错。 */
  seal(): void {
    this.sealed = true;
  }

  view(id: string, render: UiRender): void {
    this.register("view", this.views, id, render);
  }

  action(id: string, handler: UiActionHandler): void {
    this.register("action", this.actions, id, handler);
  }

  /** 校验 invalidate 的目标，返回规范化后的 `{ orgId, conversationId?, contribution }`。 */
  target(t: unknown): { orgId: string; conversationId?: string; contribution: string } {
    const name = this.manifest.name;
    const x = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const id = (v: unknown) => typeof v === "string" && v !== "" && v.length <= 200;
    if (!id(x.orgId)) throw new Error(`plugin ${name}: ui.invalidate needs a non-empty orgId`);
    if (x.conversationId !== undefined && !id(x.conversationId)) {
      throw new Error(`plugin ${name}: ui.invalidate conversationId must be a non-empty string`);
    }
    if (typeof x.contribution !== "string" || !this.contributions.has(x.contribution)) {
      throw new Error(
        `plugin ${name}: ui.invalidate: ${JSON.stringify(x.contribution)} is not a ui contribution in the manifest`,
      );
    }
    return {
      orgId: x.orgId as string,
      ...(x.conversationId !== undefined && { conversationId: x.conversationId as string }),
      contribution: x.contribution,
    };
  }

  private register<F>(what: string, map: Map<string, F>, id: string, fn: F): void {
    const name = this.manifest.name;
    if (this.sealed) {
      throw new Error(
        `plugin ${name}: ui.${what} is only allowed during setup; setup has completed`,
      );
    }
    if (typeof id !== "string" || !this.declaredViews.has(id)) {
      this.deny(`permissions.ui.views ${String(id)}`);
    }
    if (typeof fn !== "function") {
      throw new Error(`plugin ${name}: ui.${what} "${id}" handler must be a function`);
    }
    if (map.has(id)) throw new Error(`plugin ${name}: duplicate ui.${what} "${id}"`);
    map.set(id, fn);
  }
}
