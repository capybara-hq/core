import { createHash } from "node:crypto";
import type {
  Connector,
  InputRequired,
  Logger,
  ToolAnnotations,
  ToolCallContext,
  ToolResult,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { OrgRole } from "../orgs/roles.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import { SANDBOX_TOOL_NAMES } from "./builtins/sandbox/names.js";
import type { Credentials } from "./credentials.js";
import { toolKey, toolKeyIssue } from "./naming.js";

/**
 * 内核内置工具的名字（Task 10 / Task 19 实现；M5 T8 加沙箱工具）。保存 agent 时内置工具引用按这份清单校验，
 * 不依赖当前是否已注册，避免实现落地顺序影响已保存的定义；运行时未注册的照常报不可用。
 * `skill_write`（M5 T15）由 agent 定义显式引用才可用（负责人决定 agent 能否改自己的技能）。
 */
export const BUILTIN_TOOL_NAMES = [
  "ask_user",
  "read_tool_output",
  "tool_search",
  "skill_load",
  "skill_write",
  ...SANDBOX_TOOL_NAMES,
] as const;

/** 保存 agent 时引用校验的问题（`path` 为 `tools.<i>`）。 */
export interface ToolRefIssue {
  path: string;
  message: string;
}

/**
 * 内置工具处理函数的上下文：在 SDK 的 `ToolCallContext` 之上，管线额外传入本步解析出的工具
 * （`tool_search` 据此搜索）。插件处理函数收到的仍是 `ToolCallContext`。
 */
export interface BuiltinCallContext extends ToolCallContext {
  tools?: readonly ResolvedTool[];
  /** 本次运行 id（内置工具写自己的事件时用，如沙箱 deliver 的 `artifact_created`）。 */
  runId?: string;
  /**
   * 本次运行的截止时间（epoch 毫秒，`runtime.maxRunSeconds` 起算，Ruling M20）。到点运行被中止；
   * 沙箱命令按它收紧超时，赶在截止前自己超时、给模型可执行的说明。
   */
  runDeadline?: number;
}

/**
 * 内置工具的结果：`ToolResult` 之外可带 `loadedTools`（`tool_search` 加载的工具 key，
 * 管线写进 `tool_result.loadedTools`）。
 */
export type BuiltinResult = (ToolResult & { loadedTools?: string[] }) | InputRequired;

/** 内置工具的处理函数（插件的 `ToolHandler` 可直接赋给它）。 */
export type BuiltinHandler = (input: unknown, ctx: BuiltinCallContext) => Promise<BuiltinResult>;

/** 内核内置工具（`ask_user` 等，Task 10 实现具体工具）；key 就是 `spec.name`。 */
export interface BuiltinTool {
  spec: ToolSpec;
  defaultPolicy: "allow" | "ask";
  run: BuiltinHandler;
  /**
   * 本次调用的执行时限（毫秒，按已校验的输入算）；缺省为 `tools.timeoutMs`。沙箱 `bash` 按命令自己的超时加余量。
   */
  timeoutMs?: (input: unknown) => number;
  /** 结果转存阈值（字符）：与 `tools.outputSpillChars` 取小者。缺省只用配置。 */
  spillChars?: number;
  /** 本部署当前不可用时返回事实原因（英文、可执行，进「工具不可用」提醒）；可用返回 null。 */
  unavailable?: () => string | null;
}

/**
 * agent 定义里对工具的引用（Task 6 在 `AgentDefinitionSchema` 中落地同形的 zod schema）。
 * 连接器工具按连接器 id 引用，`tools: "all"` = 该连接器当前所有启用的工具。
 */
export type AgentToolRef =
  | { kind: "builtin"; name: string }
  | { kind: "plugin"; plugin: string; name: string }
  | { kind: "connector"; connectorId: string; tools: "all" | readonly string[] };

export type ToolPolicy = "allow" | "ask" | "deny";

export interface ResolvedTool {
  /** 模型可见名。 */
  key: string;
  source:
    | { kind: "builtin"; name: string }
    | { kind: "plugin"; plugin: string; name: string }
    /** `resources`：内核补上的 list_resources / read_resource（见 resources.ts），执行时路由到会话的 resources 方法。 */
    | { kind: "connector"; connectorId: string; name: string; resources?: true };
  /** 存储 / 注册时的定义（`name` 为来源内的原名，description 与 inputSchema 原样）；模型可见名用 `key`。 */
  spec: ToolSpec;
  /** sha256(canonical spec) 前 16 位。 */
  specHash: string;
  defaultPolicy: ToolPolicy;
  /** 内置工具的执行时限（见 {@link BuiltinTool.timeoutMs}）；缺省为 `tools.timeoutMs`。 */
  timeoutMs?: (input: unknown) => number;
  /** 内置工具的结果转存阈值（见 {@link BuiltinTool.spillChars}）。 */
  spillChars?: number;
  /**
   * 执行所需的最低组织角色（spec 3.6 R1）。发起人当前角色不足时转为按角色升级的审批
   * （推给持有该角色的人）。M3 的内置与连接器工具都不设。
   */
  requiredRole?: OrgRole;
}

/** 不可用的引用：`ref` 尽量写成模型认识的工具 key（`docs__search`、`docs__*`），否则 `app:<id>`。 */
export interface UnavailableTool {
  ref: string;
  reason: string;
}

/** 键排序、去掉 undefined 的 JSON（jsonb 不保留键顺序，指纹必须与顺序无关）。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 工具定义指纹：sha256(canonicalJson(spec)) 的前 16 位十六进制。 */
export function specHash(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex").slice(0, 16);
}

/** 由注解推导默认策略：只读 → allow；其余（破坏性 / 无注解）→ ask。 */
export function policyFromAnnotations(a: ToolAnnotations | undefined): "allow" | "ask" {
  return a?.readOnlyHint === true ? "allow" : "ask";
}

export interface ToolRegistryDeps {
  db: KernelDb;
  host: ExtensionHost;
  credentials: Credentials;
  log: Logger;
  builtins: BuiltinTool[];
  /**
   * 当前配置（`tools.searchThreshold*`）。不提供时从不启用 `tool_search`（只用于不关心它的测试 / 调用方）。
   */
  config?: () => KernelConfig;
}

/** `forAgent` 的结果。 */
export interface AgentTools {
  tools: ResolvedTool[];
  unavailable: UnavailableTool[];
  /**
   * `tools: "all"` 引用的连接器里未启用的工具（待复核 / 停用 / 已消失）及事实原因。不进 `unavailable`
   * （那会让每步都写「工具不可用」提醒），只在模型点名调用时用来给事实说明（spec 6.3）。缺省视为空。
   */
  hidden?: UnavailableTool[];
  /**
   * 本步是否启用 `tool_search`（spec 5.5）：启用时 `tools` 末尾含 `tool_search`，构建请求时只放内置工具
   * 与已加载工具的完整定义，其余进目录。缺省视为未启用。
   */
  toolSearch?: boolean;
}

/** 内置 `tool_search` 的名字（由注册表按组织设置与阈值自动加入，不进 agent 定义）。 */
const TOOL_SEARCH = "tool_search";
/** 内置 `skill_load` 的名字（对话日志里有技能目录快照时由注册表自动加入，不进 agent 定义）。 */
const SKILL_LOAD = "skill_load";

/** 工具定义（模型可见三项）的估算 token 数（与请求估算同一口径）。 */
function estimateToolTokens(tools: readonly ResolvedTool[]): number {
  return estimateTokens(
    [],
    [],
    tools.map((t) => ({
      name: t.key,
      description: t.spec.description,
      inputSchema: t.spec.inputSchema,
    })),
  );
}

const sourceId = (s: ResolvedTool["source"]): string =>
  s.kind === "builtin"
    ? `builtin:${s.name}`
    : s.kind === "plugin"
      ? `plugin:${s.plugin}:${s.name}`
      : `connector:${s.connectorId}:${s.name}`;

/**
 * Tool registry: resolves the references in an agent definition into the tools available for this
 * run. Not cached (reads PG and the host live every time), so changes take effect right away across
 * replicas.
 *
 * Availability:
 * - builtin: in `builtins`;
 * - extension tools: the extension is loaded and registered the tool, and this org enabled the
 *   extension (`extension_org_configs.enabled`, spec 2.2 "installed at deployment level, enabled at
 *   org level"; builtin extensions are always enabled);
 * - connector tools: the connector belongs to this org, is not deleted or disabled, the connector is
 *   installed, the tool status is `enabled` and the key is valid.
 *   `tools: "all"` takes only enabled tools; disabled / pending-review ones count as deliberately
 *   turned off by an admin and are not reported; named tools report their reason one by one.
 * Only the first of a key is kept; the same source referenced twice is deduplicated silently,
 * different sources with the same key report a duplicate.
 */
export class ToolRegistry {
  constructor(private readonly deps: ToolRegistryDeps) {}

  /** `host.list("connector")` 中 `kind` 匹配的第一个实现；未安装返回 undefined。 */
  findConnector(kind: string): Connector | undefined {
    for (const e of this.deps.host.list("connector")) {
      const impl = e.impl as Connector;
      if (impl?.kind === kind) return impl;
    }
    return undefined;
  }

  /** 同 {@link findConnector}，未安装时抛错。 */
  connector(kind: string): Connector {
    const c = this.findConnector(kind);
    if (!c) throw new Error(`connector ${kind} is not installed`);
    return c;
  }

  /**
   * The handler of a builtin / extension tool (for the execution pipeline); connector tools run
   * through the connector and return undefined. Also undefined when the extension was unloaded and so
   * on. Extension tools resolve the current instance live and call through the instance's in-flight
   * tracker (C17): on revocation it drains first and aborts at the limit, ending with
   * `ExtensionUnloadedError` (the pipeline turns it into an English error result for the model).
   */
  handler(source: ResolvedTool["source"]): BuiltinHandler | undefined {
    if (source.kind === "builtin") {
      return this.deps.builtins.find((b) => b.spec.name === source.name)?.run;
    }
    if (source.kind === "plugin") {
      const t = this.deps.host
        .tools()
        .find((x) => x.plugin === source.plugin && x.spec.name === source.name);
      if (!t) return undefined;
      return (input, ctx) =>
        t.inflight.run(ctx.signal, (signal) => t.handler(input, { ...ctx, signal }));
    }
    return undefined;
  }

  /** 已安装连接器的 kind 列表（去重，按加载顺序）。 */
  connectorKinds(): string[] {
    return [...new Set(this.deps.host.list("connector").map((e) => (e.impl as Connector).kind))];
  }

  /**
   * 保存 agent 时校验工具引用（只看「存在」，停用 / 待复核 / 插件未启用等运行时状态不拒绝，由 `forAgent` 报不可用）：
   * - 内置：名字在 {@link BUILTIN_TOOL_NAMES} 中；
   * - 插件：插件已加载且注册了该工具，key 合法；
   * - 连接器：连接器属于本组织且未删除；点名的工具必须在连接器的工具快照中。
   * 不同来源拼出同一个 key 也报出来（不截断、不猜）。
   * 返回 `keys`：这些引用可能产生的全部工具 key（`"all"` 含连接器当前所有工具，不论状态），供校验 `toolPolicies`。
   */
  async checkRefs(
    orgId: string,
    refs: readonly AgentToolRef[],
  ): Promise<{ keys: Set<string>; issues: ToolRefIssue[] }> {
    const issues: ToolRefIssue[] = [];
    const owner = new Map<string, string>();
    const pluginTools = this.deps.host.tools();
    const connectorIds = [
      ...new Set(refs.flatMap((r) => (r.kind === "connector" ? [r.connectorId] : []))),
    ];
    const apps = await this.loadConnectors(orgId, connectorIds);
    const claim = (path: string, key: string, source: string) => {
      const prev = owner.get(key);
      if (prev === undefined) owner.set(key, source);
      else if (prev !== source) {
        issues.push({ path, message: `Tool key "${key}" is already used by another tool` });
      }
    };
    refs.forEach((ref, i) => {
      const path = `tools.${i}`;
      if (ref.kind === "builtin") {
        if (!(BUILTIN_TOOL_NAMES as readonly string[]).includes(ref.name)) {
          issues.push({ path, message: `Built-in tool "${ref.name}" does not exist` });
          return;
        }
        claim(path, ref.name, `builtin:${ref.name}`);
      } else if (ref.kind === "plugin") {
        const key = toolKey(ref.plugin, ref.name);
        if (!pluginTools.some((x) => x.plugin === ref.plugin && x.spec.name === ref.name)) {
          issues.push({ path, message: `Plugin tool "${key}" does not exist` });
          return;
        }
        const issue = toolKeyIssue(key);
        if (issue) {
          issues.push({ path, message: issue });
          return;
        }
        claim(path, key, `plugin:${ref.plugin}:${ref.name}`);
      } else {
        const app = apps.get(ref.connectorId);
        if (!app || app.deleted) {
          issues.push({ path, message: `Connector "${ref.connectorId}" does not exist` });
          return;
        }
        const names = ref.tools === "all" ? app.tools.map((t) => t.name) : [...new Set(ref.tools)];
        for (const name of names) {
          if (!app.tools.some((t) => t.name === name)) {
            issues.push({
              path,
              message: `Tool "${name}" does not exist in connector ${app.slug}`,
            });
            continue;
          }
          claim(path, toolKey(app.slug, name), `connector:${app.id}:${name}`);
        }
      }
    });
    return { keys: new Set(owner.keys()), issues };
  }

  /**
   * 解析 agent 引用的工具（见类注释），再判定是否启用 `tool_search`：组织设置 `toolSearch === "on"`，且
   * 可用工具数 > `tools.searchThresholdTools` 或其定义的估算 token > `tools.searchThresholdTokens`。
   * 启用时把内置 `tool_search` 追加到末尾。定义里显式引用的 `tool_search` 忽略（由这里按设置管理）。
   * `skillLoad`：对话日志里有技能目录快照（`skills_catalog`，Ruling M17）→ 加入内置 `skill_load`（始终完整加载）；
   * 定义里显式引用的 `skill_load` 同样忽略。
   */
  async forAgent(
    orgId: string,
    def: { tools: readonly AgentToolRef[]; skillLoad?: boolean },
  ): Promise<AgentTools> {
    const { tools, unavailable, hidden } = await this.resolve(orgId, def);
    const sl = def.skillLoad === true && this.deps.builtins.find((x) => x.spec.name === SKILL_LOAD);
    if (sl) {
      tools.push({
        key: SKILL_LOAD,
        source: { kind: "builtin", name: SKILL_LOAD },
        spec: sl.spec,
        specHash: specHash(sl.spec),
        defaultPolicy: sl.defaultPolicy,
        ...(sl.timeoutMs !== undefined && { timeoutMs: sl.timeoutMs }),
      });
    }
    const toolSearch = await this.searchActive(orgId, tools);
    if (toolSearch) {
      const b = this.deps.builtins.find((x) => x.spec.name === TOOL_SEARCH) as BuiltinTool;
      tools.push({
        key: TOOL_SEARCH,
        source: { kind: "builtin", name: TOOL_SEARCH },
        spec: b.spec,
        specHash: specHash(b.spec),
        defaultPolicy: b.defaultPolicy,
      });
    }
    return { tools, unavailable, hidden, toolSearch };
  }

  /** 是否启用 `tool_search`（见 {@link forAgent}）；先比阈值，超过才读组织设置。 */
  private async searchActive(orgId: string, tools: readonly ResolvedTool[]): Promise<boolean> {
    const cfg = this.deps.config?.().tools;
    if (!cfg || !this.deps.builtins.some((b) => b.spec.name === TOOL_SEARCH)) return false;
    const over =
      tools.length > cfg.searchThresholdTools ||
      estimateToolTokens(tools) > cfg.searchThresholdTokens;
    if (!over) return false;
    return (await readOrgSettings(this.deps.db, orgId)).toolSearch === "on";
  }

  private async resolve(
    orgId: string,
    def: { tools: readonly AgentToolRef[] },
  ): Promise<{ tools: ResolvedTool[]; unavailable: UnavailableTool[]; hidden: UnavailableTool[] }> {
    const tools: ResolvedTool[] = [];
    const unavailable: UnavailableTool[] = [];
    const hidden: UnavailableTool[] = [];
    const seen = new Map<string, string>();
    const add = (t: ResolvedTool) => {
      const id = sourceId(t.source);
      const prev = seen.get(t.key);
      if (prev === undefined) {
        seen.set(t.key, id);
        tools.push(t);
      } else if (prev !== id) {
        unavailable.push({
          ref: t.key,
          reason: "Another tool with the same name is already loaded",
        });
      }
    };

    const enabledPlugins = def.tools.some((r) => r.kind === "plugin")
      ? await this.enabledPlugins(orgId)
      : new Set<string>();
    const connectorIds = [
      ...new Set(def.tools.flatMap((r) => (r.kind === "connector" ? [r.connectorId] : []))),
    ];
    const apps = await this.loadConnectors(orgId, connectorIds);
    const pluginTools = this.deps.host.tools();

    for (const ref of def.tools) {
      if (ref.kind === "builtin") {
        if (ref.name === TOOL_SEARCH || ref.name === SKILL_LOAD) continue;
        const b = this.deps.builtins.find((x) => x.spec.name === ref.name);
        if (!b) {
          unavailable.push({ ref: ref.name, reason: "Built-in tool does not exist" });
          continue;
        }
        const why = b.unavailable?.() ?? null;
        if (why !== null) {
          unavailable.push({ ref: ref.name, reason: why });
          continue;
        }
        add({
          key: b.spec.name,
          source: { kind: "builtin", name: b.spec.name },
          spec: b.spec,
          specHash: specHash(b.spec),
          defaultPolicy: b.defaultPolicy,
          ...(b.timeoutMs !== undefined && { timeoutMs: b.timeoutMs }),
          ...(b.spillChars !== undefined && { spillChars: b.spillChars }),
        });
      } else if (ref.kind === "plugin") {
        const key = toolKey(ref.plugin, ref.name);
        const t = pluginTools.find((x) => x.plugin === ref.plugin && x.spec.name === ref.name);
        if (!t) {
          unavailable.push({ ref: key, reason: "Plugin tool does not exist" });
          continue;
        }
        if (!enabledPlugins.has(ref.plugin)) {
          unavailable.push({
            ref: key,
            reason: `Plugin ${ref.plugin} is not enabled in this organization`,
          });
          continue;
        }
        const issue = toolKeyIssue(key);
        if (issue) {
          unavailable.push({ ref: key, reason: issue });
          continue;
        }
        add({
          key,
          source: { kind: "plugin", plugin: ref.plugin, name: ref.name },
          spec: t.spec,
          specHash: specHash(t.spec),
          defaultPolicy: t.spec.defaultPolicy ?? policyFromAnnotations(t.spec.annotations),
        });
      } else {
        const app = apps.get(ref.connectorId);
        if (!app) {
          unavailable.push({ ref: `app:${ref.connectorId}`, reason: "App does not exist" });
          continue;
        }
        const all = toolKey(app.slug, "*");
        if (app.deleted) {
          unavailable.push({ ref: all, reason: `App ${app.slug} was deleted` });
          continue;
        }
        if (app.status !== "active") {
          unavailable.push({ ref: all, reason: `App ${app.slug} is disabled` });
          continue;
        }
        if (!this.findConnector(app.connector)) {
          unavailable.push({
            ref: all,
            reason: `Connector ${app.connector} for app ${app.slug} is not installed`,
          });
          continue;
        }
        const wanted =
          ref.tools === "all"
            ? app.tools
            : ref.tools.map(
                (name) =>
                  app.tools.find((t) => t.name === name) ?? { name, missing: true as const },
              );
        // 「all」里未启用的工具不算 agent 点名要的，不进 unavailable（不提醒），只记进 hidden 备查
        const notEnabled = ref.tools === "all" ? hidden : unavailable;
        for (const t of wanted) {
          const key = toolKey(app.slug, t.name);
          // 远端已不再提供（漂移检测置停用并标记，见 drift.ts）：与「没有这一行」同一个事实
          if ("missing" in t || t.gone) {
            notEnabled.push({ ref: key, reason: `Tool no longer exists in app ${app.slug}` });
            continue;
          }
          if (t.status === "disabled") {
            notEnabled.push({ ref: key, reason: "Tool is disabled" });
            continue;
          }
          if (t.status === "pending_review") {
            notEnabled.push({ ref: key, reason: "Tool is pending review" });
            continue;
          }
          const issue = toolKeyIssue(key);
          if (issue) {
            unavailable.push({ ref: key, reason: issue });
            continue;
          }
          add({
            key,
            source: {
              kind: "connector",
              connectorId: app.id,
              name: t.name,
              ...(t.source === "resources" && { resources: true as const }),
            },
            spec: t.spec,
            specHash: t.specHash,
            defaultPolicy: t.defaultPolicy,
          });
        }
      }
    }
    return { tools, unavailable, hidden };
  }

  /** 本组织启用的插件（内置插件始终算启用，C14）。 */
  private async enabledPlugins(orgId: string): Promise<Set<string>> {
    return this.deps.host.enabledPlugins(orgId);
  }

  private async loadConnectors(
    orgId: string,
    ids: string[],
  ): Promise<
    Map<
      string,
      {
        id: string;
        slug: string;
        connector: string;
        status: "active" | "disabled";
        deleted: boolean;
        tools: {
          name: string;
          spec: ToolSpec;
          specHash: string;
          status: "enabled" | "disabled" | "pending_review";
          defaultPolicy: ToolPolicy;
          source: "connector" | "resources";
          /** 远端已不再提供（`missing_since` 非空）。 */
          gone: boolean;
        }[];
      }
    >
  > {
    const out = new Map();
    if (ids.length === 0) return out;
    // 软删除的连接器也读出来，只为给出「已删除」这个更准确的原因（slug 可能已被新连接器复用，按 id 区分）
    const apps = await this.deps.db
      .selectFrom("connectors")
      .select(["id", "slug", "connector", "status", "deleted_at"])
      .where("org_id", "=", orgId)
      .where("id", "in", ids)
      .execute();
    const live = apps.filter((a) => a.deleted_at === null).map((a) => a.id);
    const toolRows =
      live.length === 0
        ? []
        : await this.deps.db
            .selectFrom("connector_tools")
            .select([
              "connector_id",
              "name",
              "spec",
              "spec_hash",
              "status",
              "default_policy",
              "source",
              "missing_since",
            ])
            .where("connector_id", "in", live)
            .orderBy("name")
            .execute();
    for (const a of apps) {
      out.set(a.id, {
        id: a.id,
        slug: a.slug,
        connector: a.connector,
        status: a.status,
        deleted: a.deleted_at !== null,
        tools: toolRows
          .filter((t) => t.connector_id === a.id)
          .map((t) => ({
            name: t.name,
            spec: t.spec as ToolSpec,
            specHash: t.spec_hash,
            status: t.status,
            defaultPolicy: t.default_policy,
            source: t.source,
            gone: t.missing_since !== null,
          })),
      });
    }
    return out;
  }
}
