import type {
  ExtensionManifest,
  JsonValue,
  UiActionArgs,
  UiActionResult,
  UiQueryArgs,
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
/** The handler of a `ctx.ui.query` registration (a component's named queries, by `args.query`). */
export type UiQueryHandler = (args: UiQueryArgs) => Promise<JsonValue>;
/** The action handler of a plugin view (registered with `ctx.ui.action`). */
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

/**
 * The UI refresh message on `conv.<id>`, `org-ui.<orgId>` and `platform-ui`:
 * `{ kind: "ui", plugin, contribution, queries? }`. `queries: true` (every `ctx.ui.invalidate`)
 * tells the web to refetch the contribution's component queries too (plugin full pages spec §4.1).
 */
export interface UiBusMessage {
  kind: "ui";
  plugin: string;
  contribution: string;
  queries?: true;
}

/** 是否为界面刷新消息（bus 上的消息来自其他副本，按形状核对）。 */
export function isUiBusMessage(m: unknown): m is UiBusMessage {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.kind === "ui" && typeof x.plugin === "string" && typeof x.contribution === "string";
}

/** The SSE frame `event: ui`, data `{ plugin, contribution, queries? }`. */
export const uiFrame = (m: UiBusMessage): string =>
  `event: ui\ndata: ${JSON.stringify({
    plugin: m.plugin,
    contribution: m.contribution,
    ...(m.queries === true && { queries: true }),
  })}\n\n`;

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
  /** Query handlers registered by `ctx.ui.query`, by component id. */
  readonly queries = new Map<string, UiQueryHandler>();
  private readonly declaredViews: Set<string>;
  /** `permissions.ui.components`: the only ids `ctx.ui.query` accepts. */
  private readonly declaredComponents: Set<string>;
  private readonly contributions: Set<string>;
  /** The ids of the manifest's `component` contributions: their permission is `ui.components`. */
  private readonly components: Set<string>;
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
    this.declaredComponents = new Set(ui?.components ?? []);
    this.contributions = new Set((manifest.ui ?? []).map((c) => c.id));
    this.components = new Set(
      (manifest.ui ?? []).filter((c) => c.kind === "component").map((c) => c.id),
    );
  }

  /** Called when setup ends: view / action / query throw from then on. */
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
   * The named queries of a component (`usePluginQuery`, served by `POST …/ui/query/:plugin/:id`):
   * only an id in `permissions.ui.components`.
   */
  query(id: string, handler: UiQueryHandler): void {
    this.register("query", this.queries, id, handler, this.declaredComponents);
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

  private register<F>(
    what: string,
    map: Map<string, F>,
    id: string,
    fn: F,
    declared: ReadonlySet<string> = this.declaredViews,
  ): void {
    const name = this.manifest.name;
    if (this.sealed) {
      throw new Error(
        `plugin ${name}: ui.${what} is only allowed during setup; setup has completed`,
      );
    }
    if (typeof id !== "string" || !declared.has(id)) {
      // name the list the id belongs in: a component's server view is declared under components
      const list =
        declared === this.declaredComponents || (typeof id === "string" && this.components.has(id))
          ? "components"
          : "views";
      this.deny(`permissions.ui.${list} ${String(id)}`);
    }
    if (typeof fn !== "function") {
      throw new Error(`plugin ${name}: ui.${what} "${id}" handler must be a function`);
    }
    if (map.has(id)) throw new Error(`plugin ${name}: duplicate ui.${what} "${id}"`);
    map.set(id, fn);
  }
}
