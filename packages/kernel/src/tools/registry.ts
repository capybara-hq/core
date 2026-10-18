import { createHash } from "node:crypto";
import type {
  Connector,
  Logger,
  ToolAnnotations,
  ToolHandler,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import type { KernelDb } from "../db/kernel-schema.js";
import type { PluginHost } from "../plugins/host.js";
import type { Credentials } from "./credentials.js";
import { toolKey, toolKeyIssue } from "./naming.js";

/**
 * 内核内置工具的名字（Task 10 / Task 19 实现）。保存 agent 时内置工具引用按这份清单校验，
 * 不依赖当前是否已注册，避免实现落地顺序影响已保存的定义；运行时未注册的照常报不可用。
 */
export const BUILTIN_TOOL_NAMES = ["ask_user", "read_tool_output", "tool_search"] as const;

/** 保存 agent 时引用校验的问题（`path` 为 `tools.<i>`）。 */
export interface ToolRefIssue {
  path: string;
  message: string;
}

/** 内核内置工具（`ask_user` 等，Task 10 实现具体工具）；key 就是 `spec.name`。 */
export interface BuiltinTool {
  spec: ToolSpec;
  defaultPolicy: "allow" | "ask";
  run: ToolHandler;
}

/**
 * agent 定义里对工具的引用（Task 6 在 `AgentDefinitionSchema` 中落地同形的 zod schema）。
 * 应用工具按应用 id 引用，`tools: "all"` = 该应用当前所有启用的工具。
 */
export type AgentToolRef =
  | { kind: "builtin"; name: string }
  | { kind: "plugin"; plugin: string; name: string }
  | { kind: "app"; appId: string; tools: "all" | readonly string[] };

export type ToolPolicy = "allow" | "ask" | "deny";

export interface ResolvedTool {
  /** 模型可见名。 */
  key: string;
  source:
    | { kind: "builtin"; name: string }
    | { kind: "plugin"; plugin: string; name: string }
    | { kind: "app"; appId: string; name: string };
  /** 存储 / 注册时的定义（`name` 为来源内的原名，description 与 inputSchema 原样）；模型可见名用 `key`。 */
  spec: ToolSpec;
  /** sha256(canonical spec) 前 16 位。 */
  specHash: string;
  defaultPolicy: ToolPolicy;
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
  host: PluginHost;
  credentials: Credentials;
  log: Logger;
  builtins: BuiltinTool[];
}

const sourceId = (s: ResolvedTool["source"]): string =>
  s.kind === "builtin"
    ? `builtin:${s.name}`
    : s.kind === "plugin"
      ? `plugin:${s.plugin}:${s.name}`
      : `app:${s.appId}:${s.name}`;

/**
 * 工具注册表：把 agent 定义里的引用解析成本次运行可用的工具。不缓存（每次实时读 PG 与宿主），
 * 多副本下改动立即生效。
 *
 * 可用条件：
 * - 内置：在 `builtins` 中；
 * - 插件工具：插件已加载且注册了该工具，并且本组织启用了该插件（`plugin_org_configs.enabled`，
 *   spec 2.2「安装在部署级、启用在组织级」）；
 * - 应用工具：应用属于本组织、未删除、未停用、连接器已安装，工具状态为 `enabled` 且 key 合法。
 *   `tools: "all"` 只取启用的工具，停用 / 待复核的视为管理员有意关闭，不报；点名的工具逐个报原因。
 * 同一 key 只保留第一个；同一来源被重复引用时静默去重，不同来源撞 key 报重复。
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

  /** 已安装连接器的 kind 列表（去重，按加载顺序）。 */
  connectorKinds(): string[] {
    return [...new Set(this.deps.host.list("connector").map((e) => (e.impl as Connector).kind))];
  }

  /**
   * 保存 agent 时校验工具引用（只看「存在」，停用 / 待复核 / 插件未启用等运行时状态不拒绝，由 `forAgent` 报不可用）：
   * - 内置：名字在 {@link BUILTIN_TOOL_NAMES} 中；
   * - 插件：插件已加载且注册了该工具，key 合法；
   * - 应用：应用属于本组织且未删除；点名的工具必须在应用的工具快照中。
   * 不同来源拼出同一个 key 也报出来（不截断、不猜）。
   * 返回 `keys`：这些引用可能产生的全部工具 key（`"all"` 含应用当前所有工具，不论状态），供校验 `toolPolicies`。
   */
  async checkRefs(
    orgId: string,
    refs: readonly AgentToolRef[],
  ): Promise<{ keys: Set<string>; issues: ToolRefIssue[] }> {
    const issues: ToolRefIssue[] = [];
    const owner = new Map<string, string>();
    const pluginTools = this.deps.host.tools();
    const appIds = [...new Set(refs.flatMap((r) => (r.kind === "app" ? [r.appId] : [])))];
    const apps = await this.loadApps(orgId, appIds);
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
        const app = apps.get(ref.appId);
        if (!app || app.deleted) {
          issues.push({ path, message: `App "${ref.appId}" does not exist` });
          return;
        }
        const names = ref.tools === "all" ? app.tools.map((t) => t.name) : [...new Set(ref.tools)];
        for (const name of names) {
          if (!app.tools.some((t) => t.name === name)) {
            issues.push({ path, message: `Tool "${name}" does not exist in app ${app.slug}` });
            continue;
          }
          claim(path, toolKey(app.slug, name), `app:${app.id}:${name}`);
        }
      }
    });
    return { keys: new Set(owner.keys()), issues };
  }

  async forAgent(
    orgId: string,
    def: { tools: readonly AgentToolRef[] },
  ): Promise<{ tools: ResolvedTool[]; unavailable: UnavailableTool[] }> {
    const tools: ResolvedTool[] = [];
    const unavailable: UnavailableTool[] = [];
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
    const appIds = [...new Set(def.tools.flatMap((r) => (r.kind === "app" ? [r.appId] : [])))];
    const apps = await this.loadApps(orgId, appIds);
    const pluginTools = this.deps.host.tools();

    for (const ref of def.tools) {
      if (ref.kind === "builtin") {
        const b = this.deps.builtins.find((x) => x.spec.name === ref.name);
        if (!b) {
          unavailable.push({ ref: ref.name, reason: "Built-in tool does not exist" });
          continue;
        }
        add({
          key: b.spec.name,
          source: { kind: "builtin", name: b.spec.name },
          spec: b.spec,
          specHash: specHash(b.spec),
          defaultPolicy: b.defaultPolicy,
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
        const app = apps.get(ref.appId);
        if (!app) {
          unavailable.push({ ref: `app:${ref.appId}`, reason: "App does not exist" });
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
            ? app.tools.filter((t) => t.status === "enabled")
            : ref.tools.map(
                (name) =>
                  app.tools.find((t) => t.name === name) ?? { name, missing: true as const },
              );
        for (const t of wanted) {
          const key = toolKey(app.slug, t.name);
          if ("missing" in t) {
            unavailable.push({ ref: key, reason: `Tool no longer exists in app ${app.slug}` });
            continue;
          }
          if (t.status === "disabled") {
            unavailable.push({ ref: key, reason: "Tool is disabled" });
            continue;
          }
          if (t.status === "pending_review") {
            unavailable.push({ ref: key, reason: "Tool is pending review" });
            continue;
          }
          const issue = toolKeyIssue(key);
          if (issue) {
            unavailable.push({ ref: key, reason: issue });
            continue;
          }
          add({
            key,
            source: { kind: "app", appId: app.id, name: t.name },
            spec: t.spec,
            specHash: t.specHash,
            defaultPolicy: t.defaultPolicy,
          });
        }
      }
    }
    return { tools, unavailable };
  }

  private async enabledPlugins(orgId: string): Promise<Set<string>> {
    const rows = await this.deps.db
      .selectFrom("plugin_org_configs")
      .select("plugin")
      .where("org_id", "=", orgId)
      .where("enabled", "=", true)
      .execute();
    return new Set(rows.map((r) => r.plugin));
  }

  private async loadApps(
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
        }[];
      }
    >
  > {
    const out = new Map();
    if (ids.length === 0) return out;
    // 软删除的应用也读出来，只为给出「已删除」这个更准确的原因（slug 可能已被新应用复用，按 id 区分）
    const apps = await this.deps.db
      .selectFrom("apps")
      .select(["id", "slug", "connector", "status", "deleted_at"])
      .where("org_id", "=", orgId)
      .where("id", "in", ids)
      .execute();
    const live = apps.filter((a) => a.deleted_at === null).map((a) => a.id);
    const toolRows =
      live.length === 0
        ? []
        : await this.deps.db
            .selectFrom("app_tools")
            .select(["app_id", "name", "spec", "spec_hash", "status", "default_policy"])
            .where("app_id", "in", live)
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
          .filter((t) => t.app_id === a.id)
          .map((t) => ({
            name: t.name,
            spec: t.spec as ToolSpec,
            specHash: t.spec_hash,
            status: t.status,
            defaultPolicy: t.default_policy,
          })),
      });
    }
    return out;
  }
}
