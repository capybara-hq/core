import type {
  ExtensionManifest,
  UiActionArgs,
  UiActionResult,
  UiRenderArgs,
  UiSlotSpec,
  UiView,
} from "@capybara-hq/plugin-sdk";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";

/** 会话 id 的格式（UUID）。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an org role may use contributions in this slot (UI slots spec §7): never a `superAdmin`
 * slot (`platform.page` is served only by the org-less platform routes), else the slot's
 * `minRole`. The slot's scope rule (conversation, agent, file) is checked after this.
 */
export function canUseSlot(slot: UiSlotSpec, role: OrgRole): boolean {
  return slot.minRole !== "superAdmin" && roleAtLeast(role, slot.minRole);
}

/** 插件视图的 render 函数（`ctx.ui.view` 注册）。 */
export type UiRender = (args: UiRenderArgs) => Promise<UiView>;
/** 插件视图的动作处理函数（`ctx.ui.action` 注册）。 */
export type UiActionHandler = (args: UiActionArgs) => Promise<UiActionResult>;

/**
 * 组织级界面刷新的内核 bus 主题（命名空间 `kernel`）：`org-ui.<orgId>`。
 * 对话视图的刷新走会话主题 `conv.<id>`（与事件、增量共用），见 `conversationTopic`。
 */
export const orgUiTopic = (orgId: string): string => `org-ui.${orgId}`;

/**
 * The kernel bus topic of the platform refresh (namespace `kernel`): `ctx.ui.invalidate` of a
 * `platform.page` contribution (no `orgId`), read by `GET /api/v1/admin/ui/stream`.
 */
export const PLATFORM_UI_TOPIC = "platform-ui";

/** A checked `ui.invalidate` target: an org's (optionally one conversation's) or the platform's. */
export type UiInvalidateTarget =
  | { scope: "org"; orgId: string; conversationId?: string; contribution: string }
  | { scope: "platform"; contribution: string };

/** 界面刷新消息：`conv.<id>`、`org-ui.<orgId>` 与 `platform-ui` 上的 `{ kind: "ui", plugin, contribution }`。 */
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
 * The id must be in `permissions.ui.views` or `permissions.ui.components` (a component's server
 * view, client extensions spec §5.2); `defineExtension` already cross-checked them with the
 * manifest `ui`.
 */
export class PluginUiRegistration {
  readonly views = new Map<string, UiRender>();
  readonly actions = new Map<string, UiActionHandler>();
  private readonly declaredViews: Set<string>;
  private readonly contributions: Set<string>;
  private sealed = false;

  constructor(
    private readonly manifest: ExtensionManifest,
    /**
     * Out of scope (the id is in neither `permissions.ui.views` nor `permissions.ui.components`):
     * throws ExtensionPermissionError and writes an audit entry.
     */
    private readonly deny: (item: string) => never,
  ) {
    const ui = manifest.permissions?.ui;
    this.declaredViews = new Set([...(ui?.views ?? []), ...(ui?.components ?? [])]);
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

  /**
   * 校验 invalidate 的目标。A contribution in `platform` (the ids of the extension's `platform.page`
   * contributions) takes no `orgId` and no `conversationId`; every other contribution needs an
   * `orgId`.
   */
  target(t: unknown, platform: ReadonlySet<string>): UiInvalidateTarget {
    const name = this.manifest.name;
    const x = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const id = (v: unknown) => typeof v === "string" && v !== "" && v.length <= 200;
    if (
      x.conversationId !== undefined &&
      (typeof x.conversationId !== "string" || !UUID_RE.test(x.conversationId))
    ) {
      throw new Error(`plugin ${name}: ui.invalidate conversationId must be a UUID`);
    }
    if (typeof x.contribution !== "string" || !this.contributions.has(x.contribution)) {
      throw new Error(
        `plugin ${name}: ui.invalidate: ${JSON.stringify(x.contribution)} is not a ui contribution in the manifest`,
      );
    }
    if (platform.has(x.contribution)) {
      if (x.orgId !== undefined) {
        throw new Error(
          `plugin ${name}: ui.invalidate: ${x.contribution} is a platform page; omit orgId`,
        );
      }
      if (x.conversationId !== undefined) {
        throw new Error(
          `plugin ${name}: ui.invalidate: ${x.contribution} is a platform page; omit conversationId`,
        );
      }
      return { scope: "platform", contribution: x.contribution };
    }
    if (!id(x.orgId)) throw new Error(`plugin ${name}: ui.invalidate needs a non-empty orgId`);
    return {
      scope: "org",
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
