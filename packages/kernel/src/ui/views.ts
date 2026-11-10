import {
  type FormAnswer,
  type Logger,
  UI_ARRANGEABLE_SLOTS,
  type UiActionResult,
  type UiBlock,
  type UiContribution,
  type UiIcon,
  type UiOpen,
  type UiSlotId,
  type UiSlotScope,
  type UiView,
  validateUiView,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { isAgentVisibleIn } from "../agents/agent-lookup.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { EffectiveConfigs, NEEDS_CONFIG_REASON } from "../extensions/effective-config.js";
import { ExtensionHost, type LoadedUiContribution } from "../extensions/host.js";
import { PreviewerRegistry } from "../files/previewers.js";
import { readUiArrangement } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { OrgRole } from "../orgs/roles.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import {
  arrange,
  arrangeBySlot,
  effectiveEntry,
  isSingle,
  keyOf,
  ORG_ARRANGEABLE,
  orderItems,
  resolveSingleSlot,
  storedUse,
  type UiArrangement,
  type UiListEntry,
} from "./arrangement.js";
import { callExtension } from "./call-extension.js";
import { canUseSlot, UUID_RE } from "./registry.js";

export { callExtension } from "./call-extension.js";

/** 插件 render / action 的时限（spec §4.2：慢的插件只让那个标签失败）。 */
export const UI_CALL_TIMEOUT_MS = 5_000;

/** 列出贡献接口的一项。 */
export interface UiContributionItem {
  plugin: string;
  id: string;
  title: UiContribution["title"];
  /** The catalog slot the contribution resolved to. */
  slot: UiSlotId;
  /** For a slot with anchors: the anchor it goes after (resolved: the slot's first by default). */
  after?: string;
  kind: UiContribution["kind"];
  /** 仅 embed：插件路由下 `/ui/` 开头的路径（网页经 `/plugin-ui/<plugin>/...` 代理访问）。 */
  path?: string;
  /** From `UI_ICONS`; `puzzle` when the manifest names none. */
  icon: UiIcon;
}

/** A list slot of an arrangement listing: where its entry comes from and its items in order. */
export interface UiArrangementListSlot {
  slot: UiSlotId;
  source: "org" | "platform" | "none";
  items: (UiContributionItem & { hidden: boolean })[];
}

/**
 * A single slot of an arrangement listing (client extensions spec §6.3): the contributions that may
 * replace the built-in, the stored `use` (null = the built-in; it may name a key that is not a
 * candidate any more, which renders the built-in) and whether it is the platform's (the org has no
 * entry; always false on the platform's own listing).
 */
export interface UiArrangementSingleSlot {
  slot: UiSlotId;
  candidates: { key: string; title: UiContribution["title"] }[];
  use: string | null;
  followsPlatform: boolean;
}

/** One slot of an arrangement listing. */
export type UiArrangementSlot = UiArrangementListSlot | UiArrangementSingleSlot;

/** 嵌入应用的签发目标：已核对组织启用与对话访问。 */
export interface UiEmbedTarget {
  plugin: string;
  contribution: string;
  /** 清单里的 `path`（`/ui/` 开头）。 */
  path: string;
  conversationId?: string;
  /** Only an agent embed: the agent the token is for. */
  agentId?: string;
  /** Only a `file.preview` embed: the one file the token is for. */
  fileId?: string;
}

interface UiViewsDeps {
  host: Pick<ExtensionHost, "uiContributions">;
  /**
   * The effective deployment config of an extension for an org (layering spec A §6): passed to
   * `render` / `action` as `config`; when it is not valid the block fails alone (409
   * `extension.needs_config`) and the extension is not called.
   */
  effective: Pick<EffectiveConfigs, "get" | "platform">;
  /** Names of the extensions enabled in the organization (`extension_org_configs.enabled` plus required bootstrap plugins, `enabled.ts`), queried every time, not cached. */
  enabledPlugins(orgId: string): Promise<Set<string>>;
  /** 调用者能否访问这个对话（与会话 SSE 流同一判定）。 */
  canAccessConversation(orgId: string, conversationId: string, accountId: string): Promise<boolean>;
  /** Whether the caller can read the agent and it belongs to `orgId` ({@link isAgentVisibleIn}). */
  canReadAgent(orgId: string, agentId: string, accountId: string): Promise<boolean>;
  /**
   * Throws unless the caller may write to the conversation: a sub-agent's is read-only (409
   * `conversation.read_only`, sub-agents spec §6.1). Checked before an action (final review m3).
   */
  checkWritable?(orgId: string, conversationId: string, accountId: string): Promise<void>;
  /**
   * A `file.preview` embed token: whether that extension's previewer with `embed: contribution`
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
  /** The org's stored arrangement, read live (lists only; never the access gate). */
  orgArrangement(orgId: string): Promise<UiArrangement | undefined>;
  /** The platform default arrangement, read live (lists only; never the access gate). */
  platformArrangement(): Promise<UiArrangement>;
  log: Pick<Logger, "warn">;
}

/** 取视图 / 执行动作的调用者与目标（身份来自内核鉴权）: an org route's. */
export interface UiOrgTarget {
  scope?: "org";
  orgId: string;
  accountId: string;
  /** 调用者在 `orgId` 的角色（OrgGuard 查出的成员关系）。 */
  role: OrgRole;
  plugin: string;
  id: string;
  conversationId?: string;
  /** Only an agent view or embed (`agent.detail.section`). */
  agentId?: string;
  locale: "zh" | "en";
  /** A panel opened from an open target: the item to scroll to. */
  item?: string;
  /** An inline card: the tool call it hangs off and its `ToolResult.card.key`. */
  card?: { callId: string; key?: string };
}

/** A super admin's request on the org-less admin UI routes (`platform.page` only). */
export interface UiPlatformTarget {
  scope: "platform";
  accountId: string;
  plugin: string;
  id: string;
  locale: "zh" | "en";
}

/** The caller and target of a view, action or embed: an org route's or the platform's. */
export type UiTarget = UiOrgTarget | UiPlatformTarget;

/** {@link UiTarget} without `locale`, per variant (what `embed` takes). */
export type UiEmbedRequest =
  | (Omit<UiOrgTarget, "locale"> & { fileId?: string })
  | Omit<UiPlatformTarget, "locale">;

/** The log field naming where a target is: its org, or the platform scope. */
const whereOf = (t: UiTarget): { orgId: string } | { scope: "platform" } =>
  t.scope === "platform" ? { scope: "platform" } : { orgId: t.orgId };

/** The args passed to the extension's `render` / `action`, without the signal. */
type ResolvedArgs =
  | {
      scope: Exclude<UiSlotScope, "platform">;
      orgId: string;
      accountId: string;
      role: OrgRole;
      slot: UiSlotId;
      locale: UiTarget["locale"];
      config: unknown;
      conversationId?: string;
      agentId?: string;
      item?: string;
      card?: { callId: string; key?: string };
    }
  | {
      scope: "platform";
      orgId?: undefined;
      accountId: string;
      role: "superAdmin";
      slot: UiSlotId;
      locale: UiTarget["locale"];
      config: unknown;
      conversationId?: undefined;
      agentId?: undefined;
      item?: undefined;
      card?: undefined;
    };

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

/**
 * Lists contributions for a listing route: no alias, a view's render registered (an embed or a
 * component is listed without one: a component's server view is optional); base order (spec §5):
 * extension name, then manifest order (stable).
 */
function listed(entries: LoadedUiContribution[]): UiContributionItem[] {
  return entries
    .filter(
      (c) =>
        c.contribution.aliasOf === undefined &&
        (c.contribution.kind === "embed" || c.contribution.kind === "component" || c.render),
    )
    .map((c, i) => ({ c, i }))
    .sort((x, y) => (x.c.plugin === y.c.plugin ? x.i - y.i : x.c.plugin < y.c.plugin ? -1 : 1))
    .map(({ c: { plugin, contribution: c, slot: s, after } }) => ({
      plugin,
      id: c.id,
      title: c.title,
      slot: s.id,
      ...(after !== undefined && { after }),
      kind: c.kind,
      ...(c.kind === "embed" && c.path !== undefined && { path: c.path }),
      icon: c.icon ?? "puzzle",
    }));
}

/** The candidates of a single slot in an arrangement listing. */
const candidatesOf = (items: UiContributionItem[]): UiArrangementSingleSlot["candidates"] =>
  items.map((i) => ({ key: keyOf(i), title: i.title }));

/** The items in effective order, each marked hidden or not (hidden ones stay in place). */
function withHidden(
  items: UiContributionItem[],
  entry: UiListEntry,
): (UiContributionItem & { hidden: boolean })[] {
  const hidden = new Set(entry.hidden);
  return orderItems(items, entry).map((i) => ({ ...i, hidden: hidden.has(`${i.plugin}/${i.id}`) }));
}

/** A platform route's contribution: found, and in `platform.page`; else 404. */
function platformEntry(entry: LoadedUiContribution | undefined): LoadedUiContribution {
  if (entry === undefined || entry.slot.id !== "platform.page") throw notFound();
  return entry;
}

const TOAST_MAX = 500;
const MAX_LOGGED_PROBLEMS = 10;

const notFound = () => new ApiError("ui.not_found", "UI contribution not found");

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 校验动作结果，返回问题列表（空 = 合法）。A new `view` may carry `data` only for a component
 * (`component`).
 */
function actionResultProblems(r: unknown, component: boolean): string[] {
  if (!isObj(r)) return ["action result must be an object"];
  if (r.view !== undefined) return validateUiView(r.view, { component }).map((p) => `view: ${p}`);
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
 * - every request goes through one gate (`resolve`): the slot's `minRole` (never `platform.page`),
 *   then its scope rule (conversation: readable, like the SSE stream; agent: readable and in this
 *   org; org: the role alone); refused is 404 `ui.not_found`, the same as not existing;
 * - a view takes only the context id of its scope (`conversationId` / `agentId`): a missing one or
 *   one of another scope is 400 `validation_failed`;
 * - a component's server view (`ctx.ui.view(<component id>)`) is served like a view of its slot;
 *   only its views carry `data` (a plain view's `data` is 502 `ui.invalid_view`);
 * - 调用带 5 秒时限与中止信号：render 抛错 502 `ui.render_failed`、action 抛错 502 `ui.action_failed`、
 *   超时 504 `ui.timeout`、返回非法视图 502
 *   `ui.invalid_view`，都记告警日志、不写对话日志（这些不是模型可见的内容）。
 * 不保存跨请求状态。
 */
@Injectable()
export class UiViews {
  private readonly d: UiViewsDeps;

  constructor(
    @Inject(ExtensionHost) host: ExtensionHost,
    @Inject(ConversationsService) conversations: ConversationsService,
    @Inject(PreviewerRegistry) previewers: PreviewerRegistry,
    @Inject(KernelDb) db: KernelDb,
    @Inject(KERNEL_LOGGER) log: Pick<Logger, "warn">,
    @Inject(EffectiveConfigs) effective: Pick<EffectiveConfigs, "get" | "platform">,
  ) {
    this.d = {
      host,
      effective,
      // org config rows plus the required bootstrap plugins
      enabledPlugins: (orgId) => host.enabledPlugins(orgId),
      canAccessConversation: (orgId, id, accountId) =>
        conversations.isAccessible(orgId, id, accountId),
      canReadAgent: (orgId, agentId, accountId) =>
        isAgentVisibleIn(db.db, orgId, agentId, accountId),
      checkWritable: async (orgId, id, accountId) => {
        await conversations.writable(orgId, id, accountId);
      },
      previewEmbedAllowed: (t) => previewers.embedAllowed(t),
      recordedCard: (conversationId, callId) => recordedCard(db.db, conversationId, callId),
      orgArrangement: async (orgId) => (await readOrgSettings(db.db, orgId)).uiArrangement,
      platformArrangement: () => readUiArrangement(db.db),
      log,
    };
  }

  /**
   * The contributions the role may use in the org, of one slot or of every org-reachable slot:
   * the extension enabled and loaded, a view's render registered (a component is listed with or
   * without a server view), the slot's `minRole` ({@link canUseSlot}, so never `platform.page`);
   * no alias, no `file.preview` contribution (the file previewers list those). Base order (spec
   * §5): extension name, then manifest order. A single slot lists at most its winner
   * ({@link resolveSingleSlot} over what this role may use: none until one is chosen, and the web
   * renders the built-in); display only, the routes that serve a contribution never read it. The
   * winner is listed whether or not its client code may load (kill switch, per-plugin disable,
   * client API support): the web renders the built-in when the org's client set has no such
   * component, and any other consumer must do the same.
   */
  async contributions(
    orgId: string,
    role: OrgRole,
    slot?: UiSlotId,
  ): Promise<UiContributionItem[]> {
    const items = await this.orgBase(orgId, role, slot);
    if (items.length === 0) return items;
    const [org, platform] = await Promise.all([
      this.d.orgArrangement(orgId),
      this.d.platformArrangement(),
    ]);
    const winners = new Map<UiSlotId, string | null>();
    const winnerOf = (s: UiSlotId): string | null => {
      if (!winners.has(s)) {
        const available = new Set(items.filter((i) => i.slot === s).map(keyOf));
        winners.set(s, resolveSingleSlot(s, org?.[s], platform[s], available));
      }
      return winners.get(s) ?? null;
    };
    const shown = items.filter((i) => !isSingle(i.slot) || keyOf(i) === winnerOf(i.slot));
    return arrangeBySlot(shown, (s) => effectiveEntry(org, platform, s).entry);
  }

  /** {@link contributions} before the arrangement: what the role may use, in base order. */
  private async orgBase(
    orgId: string,
    role: OrgRole,
    slot: UiSlotId | undefined,
  ): Promise<UiContributionItem[]> {
    const all = this.d.host.uiContributions();
    if (all.length === 0) return [];
    const enabled = await this.d.enabledPlugins(orgId);
    return listed(
      all.filter(
        (c) =>
          enabled.has(c.plugin) &&
          c.slot.id !== "file.preview" &&
          (slot === undefined || c.slot.id === slot) &&
          canUseSlot(c.slot, role),
      ),
    );
  }

  /**
   * The arrangement page of an org: every org-arrangeable slot with the contributions the role may
   * use: a list slot in effective order with the hidden ones in place, and where the entry comes
   * from; a single slot with its candidates, the stored `use` and whether it follows the platform.
   */
  async arrangementView(orgId: string, role: OrgRole): Promise<UiArrangementSlot[]> {
    // the page is for people who arrange or at least see the org's UI, not for a guest
    if (role === "guest") throw notFound();
    const [base, org, platform] = await Promise.all([
      this.orgBase(orgId, role, undefined),
      this.d.orgArrangement(orgId),
      this.d.platformArrangement(),
    ]);
    return ORG_ARRANGEABLE.map((slot): UiArrangementSlot => {
      const items = base.filter((i) => i.slot === slot);
      if (isSingle(slot)) {
        return { slot, candidates: candidatesOf(items), ...storedUse(org, platform, slot) };
      }
      const { entry, source } = effectiveEntry(org, platform, slot);
      return { slot, source, items: withHidden(items, entry) };
    });
  }

  /**
   * The platform's arrangement page: every arrangeable slot with the contributions of every running
   * extension (whatever its org enablement): a list slot ordered by the platform entry, hidden ones
   * in place; a single slot with its candidates and the platform's `use`.
   */
  async platformArrangementView(): Promise<UiArrangementSlot[]> {
    const [base, platform] = await Promise.all([
      listed(this.d.host.uiContributions().filter((c) => c.slot.id !== "file.preview")),
      this.d.platformArrangement(),
    ]);
    return UI_ARRANGEABLE_SLOTS.map((slot): UiArrangementSlot => {
      const items = base.filter((i) => i.slot === slot);
      if (isSingle(slot)) {
        const { use } = storedUse(undefined, platform, slot);
        return { slot, candidates: candidatesOf(items), use, followsPlatform: false };
      }
      const { entry, source } = effectiveEntry(undefined, platform, slot);
      return { slot, source, items: withHidden(items, entry) };
    });
  }

  /**
   * The `platform.page` contributions of the running extensions, for the admin console (super
   * admins; no org enablement applies): no alias, a view's render registered (a component is
   * listed with or without a server view). Base order like {@link contributions}.
   */
  async platformContributions(): Promise<UiContributionItem[]> {
    const items = listed(
      this.d.host.uiContributions().filter((c) => c.slot.id === "platform.page"),
    );
    const { entry } = effectiveEntry(
      undefined,
      await this.d.platformArrangement(),
      "platform.page",
    );
    return arrange(items, entry);
  }

  /**
   * 嵌入应用：核对贡献是 embed、插件在该组织启用；对话嵌入要求调用者能访问该对话（否则 404，与视图一致），
   * 组织页面不收 `conversationId`。返回签发令牌所需的目标（令牌由调用方签）。
   */
  async embed(t: UiEmbedRequest): Promise<UiEmbedTarget> {
    let fileId: string | undefined;
    let target: UiTarget;
    if (t.scope === "platform") target = { ...t, locale: "en" };
    else {
      const { fileId: f, ...org } = t;
      fileId = f;
      target = { ...org, locale: "en" };
    }
    const { entry, args } = await this.resolve(target, "embed");
    const path = entry.contribution.path;
    if (path === undefined) throw notFound();
    const preview = entry.slot.id === "file.preview";
    if (preview !== (fileId !== undefined)) {
      throw new ApiError(
        "validation_failed",
        preview
          ? "fileId is required for a file-preview embed"
          : "fileId is only allowed for a file-preview embed",
      );
    }
    if (fileId !== undefined) {
      // a file-preview embed is an org's (a platform target never carries a fileId)
      if (args.orgId === undefined) throw notFound();
      const allowed =
        this.d.previewEmbedAllowed !== undefined &&
        (await this.d.previewEmbedAllowed({
          orgId: args.orgId,
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
      ...(args.agentId !== undefined && { agentId: args.agentId }),
      ...(fileId !== undefined && { fileId }),
    };
  }

  /** 取视图：调用插件 `render`，校验返回的视图。 */
  async render(t: UiTarget): Promise<UiView> {
    const { entry, args } = await this.resolve(t, "render");
    const render = entry.render as NonNullable<LoadedUiContribution["render"]>;
    const view = await this.call(t, "render", (signal) => render({ ...args, signal }));
    // `data` only from a component's view (client extensions spec §5.2)
    this.check(
      t,
      "render",
      validateUiView(view, { component: entry.contribution.kind === "component" }),
    );
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
    this.check(t, "action", actionResultProblems(r, entry.contribution.kind === "component"));
    const res = r as { view?: UiView; toast?: { zh: string; en: string } };
    if (res.view !== undefined) return { view: dropForeignOpens(res.view, this.panels(t.plugin)) };
    return res.toast !== undefined ? { toast: { zh: res.toast.zh, en: res.toast.en } } : {};
  }

  /** Ids of the extension's live `panel` contributions (aliases of panels included). */
  private panels(plugin: string): Set<string> {
    return new Set(
      this.d.host
        .uiContributions()
        .filter((c) => c.plugin === plugin && c.slot.id === "conversation.panel")
        .map((c) => c.contribution.id),
    );
  }

  /**
   * The single access gate of the org UI routes (UI slots spec §7): finds the contribution (a
   * retired alias answers with the one it names), then checks, in order, that its slot is reachable
   * from an org (not `platform`), the role meets the slot's `minRole`, the extension is enabled in
   * the org, its effective config is valid, and the slot's scope rule (conversation: readable;
   * agent: readable and in this org; org: the role alone; file: a conversation the caller reads,
   * the previewer's grant is checked by `embed`). A platform target (the admin routes) takes the
   * platform gate instead ({@link platformArgs}): only a `platform.page` contribution. Returns the
   * args passed to the extension (no signal). Anything refused for a contribution that exists is
   * 404 `ui.not_found`.
   */
  private async resolve(
    t: UiTarget,
    need: "render" | "action" | "embed",
  ): Promise<{ entry: LoadedUiContribution; args: ResolvedArgs }> {
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
          : // a view, or a component's server view (served like a view of its slot)
            (c.contribution.kind === "view" || c.contribution.kind === "component") &&
            c[need] !== undefined),
    );
    if (t.scope === "platform") {
      const found = platformEntry(entry);
      return { entry: found, args: this.platformArgs(t, found) };
    }
    if (!entry || entry.slot.scope === "platform" || !canUseSlot(entry.slot, t.role)) {
      throw notFound();
    }
    if (!(await this.d.enabledPlugins(t.orgId)).has(t.plugin)) throw notFound();
    // spec A §6: the extension is not called for an org whose effective config is not valid
    const effective = await this.d.effective.get(t.orgId, t.plugin);
    if (!effective.ok) {
      throw new ApiError("extension.needs_config", `Extension ${t.plugin} ${NEEDS_CONFIG_REASON}`);
    }
    const scope = entry.slot.scope;
    const base = {
      orgId: t.orgId,
      accountId: t.accountId,
      role: t.role,
      slot: entry.slot.id,
      scope,
      locale: t.locale,
      config: effective.config,
    };
    const what = need === "embed" ? "embed" : "view";
    const conversational = scope === "conversation" || scope === "file";
    if (!conversational && (t.item !== undefined || t.card !== undefined)) {
      throw new ApiError("validation_failed", "item and callId are for conversation views");
    }
    if (scope !== "agent" && t.agentId !== undefined) {
      throw new ApiError("validation_failed", `agentId is only allowed for an agent ${what}`);
    }
    if (scope === "agent") {
      if (t.conversationId !== undefined) {
        throw new ApiError(
          "validation_failed",
          `conversationId is not allowed for an agent ${what}`,
        );
      }
      const agentId = t.agentId;
      if (agentId === undefined) {
        throw new ApiError("validation_failed", `agentId is required for an agent ${what}`);
      }
      if (!UUID_RE.test(agentId) || !(await this.d.canReadAgent(t.orgId, agentId, t.accountId))) {
        throw notFound();
      }
      return { entry, args: { ...base, agentId } };
    }
    if (!conversational) {
      if (t.conversationId !== undefined) {
        throw new ApiError(
          "validation_failed",
          `conversationId is not allowed for an organization page ${what}`,
        );
      }
      return { entry, args: base };
    }
    const conversationId = t.conversationId;
    if (conversationId === undefined) {
      throw new ApiError(
        "validation_failed",
        `conversationId is required for a conversation ${what}`,
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
        entry.slot.id === "conversation.tool-result.card" && this.d.recordedCard !== undefined
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

  /**
   * The platform gate (UI slots spec §7): the contribution is a `platform.page` of a running
   * extension (no org enablement applies), given the platform's deployment config. The caller is a
   * super admin (`@SuperAdmin` on the admin routes); anything else is 404 `ui.not_found`.
   */
  private platformArgs(t: UiPlatformTarget, entry: LoadedUiContribution): ResolvedArgs {
    const effective = this.d.effective.platform(t.plugin);
    // `platform()` fails only when the extension is not running here: not found
    if (!effective.ok) throw notFound();
    return {
      scope: "platform",
      accountId: t.accountId,
      role: "superAdmin",
      slot: entry.slot.id,
      locale: t.locale,
      config: effective.config,
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
      fields: { plugin: t.plugin, contribution: t.id, ...whereOf(t) },
      timeoutMs: UI_CALL_TIMEOUT_MS,
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
      ...whereOf(t),
      problems: problems.slice(0, MAX_LOGGED_PROBLEMS),
    });
    throw new ApiError("ui.invalid_view", `Plugin ${t.plugin} returned an invalid view`);
  }
}
