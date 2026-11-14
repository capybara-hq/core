import { createHash } from "node:crypto";
import type {
  Connector,
  ConversationSource,
  HookParentScope,
  InputRequired,
  NetworkBlockedHost,
  ToolAnnotations,
  ToolCallContext,
  ToolResult,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { connectorToolKey, extensionToolKey } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  type AgentDefinition,
  builtinDisabled,
  connectorToolDisabled,
  type DisabledToolRef,
  extensionToolDisabled,
  type SubagentTools,
} from "../agents/definition.js";
import type { ToolView } from "../conversations/events.js";
import { EffectiveConfigs, NEEDS_CONFIG_REASON } from "../extensions/effective-config.js";
import { ExtensionHost } from "../extensions/host.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import type { OrgRole } from "../orgs/roles.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import type { ConversationKindForHooks } from "../runtime/hook-calls.js";
import { SUBAGENT_LIMIT_DEFAULTS, subagentLimits } from "../runtime/subagents/limits.js";
import { resolveRoster } from "../runtime/subagents/roster.js";
import {
  AGENT_BUILTIN_NAMES,
  AGENT_TOOL,
  BASH_COMPANION_TOOLS,
  BUILTIN,
  SEND_MESSAGE,
  SKILL_LOAD,
  SUBAGENT_HANDBACK,
  TOOL_SEARCH,
} from "./builtin-names.js";
import { agentToolSpec } from "./builtins/agent.js";
import { BuiltinTools } from "./builtins/builtin-tools.js";
import { canonicalJson } from "./canonical-json.js";
import { legacyKeySaveText } from "./legacy-keys.js";
import { toolKeyIssue } from "./naming.js";
import { OrgToolSwitches, toolTurnedOffReason } from "./org-tool-switches.js";

export { BUILTIN_TOOL_NAMES } from "./builtin-names.js";
export { canonicalJson } from "./canonical-json.js";

/**
 * What a tool's `unavailable` is asked with: the org, and for a run's listing the root
 * conversation (`conversationId`; the sandbox tools follow its device, ruling R8), whether
 * the run is an eval replay (`replay`: its tool calls are never executed), and a `memo` shared by
 * the tools of one listing (one answer per question per listing).
 */
export interface ToolListingScope {
  orgId: string;
  conversationId?: string;
  replay?: boolean;
  memo?: Map<string, unknown>;
}

/** A problem of a saved definition's `disabledTools` (`path` is `disabledTools.<i>`). */
export interface ToolRefIssue {
  path: string;
  message: string;
}

/**
 * 内置工具处理函数的上下文：在 SDK 的 `ToolCallContext` 之上，管线额外传入本步解析出的工具
 * （`ToolSearch` 据此搜索）。插件处理函数收到的仍是 `ToolCallContext`。
 */
export interface BuiltinCallContext extends ToolCallContext {
  tools?: readonly ResolvedTool[];
  /** 本次运行 id（内置工具写自己的事件时用，如沙箱 deliver 的 `artifact_created`）。 */
  runId?: string;
  /**
   * 本次运行的截止时间（epoch 毫秒，`runtime.maxRunSeconds` 起算，Ruling M20）。到点运行被中止；
   * 沙箱命令按它收紧超时，赶在截止前自己超时、给模型可执行的说明。
   * Absent when the run has no duration limit (`runtime.maxRunSeconds` 0): commands are then limited
   * only by `sandbox.limits.maxCommandSeconds` and the tool timeouts.
   */
  runDeadline?: number;
  /**
   * The conversation whose sandbox this call uses (sub-agents spec §10.1, agent map spec §6): the
   * root conversation for a sub-agent's call at any depth, the conversation itself otherwise (the
   * default when absent).
   */
  sandboxConversationId?: string;
  /** The parent run of a sub-agent's run (absent for a top-level run). */
  parentRunId?: string;
  /**
   * A sub-agent's run: the tree's budget window of this run (`SubagentParent.budgetRunId`), which
   * a builtin's own model call (the `WebFetch` extraction) counts its tokens on.
   */
  budgetRunId?: string;
  /**
   * The rest of the run's hook scope, for a builtin that makes a model call of its own (the
   * `WebFetch` extraction fires `model.request` / `model.response`): the step of the call, the
   * agent version of the run, the conversation kind (hooks fire for `chat` and `subagent` only)
   * and, for a sub-agent, where it was dispatched from.
   */
  step?: number;
  agentVersion?: number;
  conversationKind?: ConversationKindForHooks;
  parent?: HookParentScope;
}

/**
 * 内置工具的结果：`ToolResult` 之外可带 `loadedTools`（`ToolSearch` 加载的工具 key，
 * 管线写进 `tool_result.loadedTools`）。
 */
export type BuiltinResult =
  | (ToolResult & {
      loadedTools?: string[];
      /**
       * Structured display view (UI refresh B; the pipeline writes it to `tool_result.view` after
       * checking it against `ToolViewSchema`). Builtins only: extension tools cannot set it.
       */
      view?: ToolView;
      /**
       * Kernel-internal (never written to the log or sent to the model): the network hosts a
       * foreground command on a device was refused (`Bash`; network ask-to-allow spec §6.2). The
       * pipeline turns it into `network_blocked`, an ask to the device owner or notes.
       */
      networkReport?: { deviceId: string; blocked: NetworkBlockedHost[] };
      /**
       * Kernel-internal (never written to the log or sent to the model): `gh auth login --web`'s
       * device code an exec printed (`Bash`; auto mode spec §6, P-D13). The pipeline turns it into
       * the display-only `device_code` event the web draws as a card.
       */
      loginCode?: { url: string; code: string };
    })
  | InputRequired;

/** 内置工具的处理函数（插件的 `ToolHandler` 可直接赋给它）。 */
export type BuiltinHandler = (input: unknown, ctx: BuiltinCallContext) => Promise<BuiltinResult>;

/** 内核内置工具（`AskUserQuestion` 等，Task 10 实现具体工具）；key 就是 `spec.name`。 */
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
  /**
   * The factual reason this tool is unavailable for the org right now (English, actionable; it goes
   * into the "tool unavailable" reminder), or null when it is available. May be async (e.g. a
   * per-org extension-point default). See {@link ToolListingScope} for what a listing passes.
   */
  unavailable?: (ctx: ToolListingScope) => Promise<string | null> | string | null;
  /**
   * A policy key derived from the validated input (Platform tool spec §6.2), or null to use the
   * tool key. With a key, agent and parent policies, grants and approvals are keyed by it (an
   * agent's policy on the tool key still applies on top); the model-visible key stays the tool key.
   * May be async (the `Platform` tool reads the actor's facts); it never throws for bad input:
   * an input that cannot run is a `deny` with a `denyReason`.
   */
  callPolicy?: CallPolicyFn;
}

/** Where a call happens, for {@link BuiltinTool.callPolicy}: the runtime's context, never input. */
export interface CallPolicyContext {
  orgId: string;
  /** The run's trigger account. */
  accountId: string;
  agentId: string;
  conversationId: string;
  /** Null outside a run (a builtin called directly). */
  runId: string | null;
  /**
   * The call's input as the model sent it, before `{"$output": id}` references were resolved
   * (the approval card shows this form). Absent outside the pipeline.
   */
  rawInput?: unknown;
  /** The run's abort signal (a precheck stops with it). Absent outside the pipeline. */
  signal?: AbortSignal;
}

/** {@link BuiltinTool.callPolicy}. */
export type CallPolicyFn = (
  input: unknown,
  ctx: CallPolicyContext,
) => CallPolicy | null | Promise<CallPolicy | null>;

/** What {@link BuiltinTool.callPolicy} returns for one call. */
export interface CallPolicy {
  /** The policy key, e.g. `Platform:skills.create`. */
  key: string;
  /** The default for this call (it replaces the tool's `defaultPolicy`). */
  policy: ToolPolicy;
  /**
   * False: always confirm, only "once": the approval offers only "once" and remembered grants
   * never apply.
   */
  remember: boolean;
  /** The bilingual summary shown on the approval (rendered by the kernel, never by the model). */
  summary?: { zh: string; en: string };
  /** With `policy: "deny"`: the actionable English reason returned as the tool error. */
  denyReason?: string;
}

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
  /** A builtin's per-call policy key (see {@link BuiltinTool.callPolicy}). */
  callPolicy?: CallPolicyFn;
}

/** 不可用的引用：`ref` 尽量写成模型认识的工具 key（`mcp__docs__search`、`mcp__docs__*`），否则 `app:<id>`。 */
export interface UnavailableTool {
  ref: string;
  reason: string;
}

/** The first 16 hex digits of sha256(canonicalJson(v)): a fingerprint independent of key order. */
export function contentHash(v: unknown): string {
  return createHash("sha256").update(canonicalJson(v)).digest("hex").slice(0, 16);
}

/**
 * `ToolSpec` fields that are display only (UI refresh B): never sent to the model and left out of
 * the definition fingerprint, so adding or changing them never changes `model_call.request.tools`,
 * never sends a connector tool to drift review and never invalidates a remembered grant.
 */
export const DISPLAY_ONLY_SPEC_FIELDS = ["title", "keyArgs"] as const;

/** A tool spec without its {@link DISPLAY_ONLY_SPEC_FIELDS} (non-objects unchanged). */
export function withoutDisplayFields<T>(spec: T): T {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const out = { ...(spec as Record<string, unknown>) };
  for (const f of DISPLAY_ONLY_SPEC_FIELDS) delete out[f];
  return out as T;
}

/**
 * Tool definition fingerprint: {@link contentHash} of the spec without its display-only fields
 * (`title`, `keyArgs`). Specs without them hash exactly as before.
 */
export function specHash(spec: unknown): string {
  return contentHash(withoutDisplayFields(spec));
}

/** 由注解推导默认策略：只读 → allow；其余（破坏性 / 无注解）→ ask。 */
export function policyFromAnnotations(a: ToolAnnotations | undefined): "allow" | "ask" {
  return a?.readOnlyHint === true ? "allow" : "ask";
}

/** Why an extension tool limited by `spec.sources` is not offered in a `source` conversation. */
export const sourceHiddenReason = (source: ConversationSource): string =>
  `Not available in ${source} conversations`;

/** `forAgent` 的结果。 */
export interface AgentTools {
  tools: ResolvedTool[];
  unavailable: UnavailableTool[];
  /**
   * Tools the agent would have that cannot be offered now, with the facts (a builtin with no
   * sandbox, an extension that needs config or a tool the org switched off, a connector tool off,
   * pending review or gone). Not in `unavailable` (that would remind the model every step of tools
   * it never asked for, tools default-on spec §4); used only to explain a call the model makes by
   * name (spec 6.3). Absent = empty.
   */
  hidden?: UnavailableTool[];
  /**
   * 本步是否启用 `ToolSearch`（spec 5.5）：启用时 `tools` 末尾含 `ToolSearch`，构建请求时只放内置工具
   * 与已加载工具的完整定义，其余进目录。缺省视为未启用。
   */
  toolSearch?: boolean;
}

// `ToolSearch` is added by the registry by org setting and threshold, `Skill` when the log has a
// skills catalog snapshot; neither comes from agent definitions (`./builtin-names.ts`).

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

/** A builtin as a resolved tool (with `spec`, which `Agent` builds per definition). */
const builtinTool = (b: BuiltinTool, spec: ToolSpec): ResolvedTool => ({
  key: b.spec.name,
  source: { kind: "builtin", name: b.spec.name },
  spec,
  specHash: specHash(spec),
  defaultPolicy: b.defaultPolicy,
  ...(b.timeoutMs !== undefined && { timeoutMs: b.timeoutMs }),
  ...(b.spillChars !== undefined && { spillChars: b.spillChars }),
  ...(b.callPolicy !== undefined && { callPolicy: b.callPolicy }),
});

/**
 * Tool registry: resolves what an agent has for this run (tools default-on spec §4): everything
 * the org offers minus the definition's `disabledTools`. Not cached (reads PG and the host live
 * every time), so changes take effect right away across replicas.
 *
 * What is offered:
 * - builtins: every {@link AGENT_BUILTIN_NAMES} entry registered here that can run (`unavailable`
 *   says why not), `TaskOutput` / `TaskStop` / `TaskList` with `Bash`, `Agent` while its roster is not empty;
 * - extension tools: every tool registered by an extension loaded on this replica and enabled in
 *   the org (`extension_org_configs.enabled`; required bootstrap plugins are enabled in every org,
 *   `enabled.ts`), whose effective config for the org is valid (layering spec A §6) and that the
 *   org did not switch off (§7: the org's switch wins);
 * - connector tools: every enabled tool of every live, active connector of the org whose
 *   connector extension is installed, with a valid key.
 * What cannot be offered goes to `hidden` with the reason; nothing is reported to the model as
 * unavailable except two sources with one key (the first wins).
 */
@Injectable()
export class ToolRegistry {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    /** Extension tools and the organization's enabled extensions. */
    @Inject(ExtensionHost) private readonly host: Pick<ExtensionHost, "tools" | "enabledPlugins">,
    /** The installed connectors (`connector@1`, from the extension registry). */
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "list">,
    @Inject(BuiltinTools) private readonly builtinTools: Pick<BuiltinTools, "list">,
    /**
     * The extensions' effective config per org (layering spec A §6): an extension tool is
     * unavailable in an org whose effective config is not valid.
     */
    @Inject(EffectiveConfigs) private readonly effective: Pick<EffectiveConfigs, "get">,
    /** The org's switches of single extension tools (layering spec A §7). */
    @Inject(OrgToolSwitches) private readonly switches: Pick<OrgToolSwitches, "offKeys">,
    /**
     * `tools.searchThreshold*` and the sub-agent limits. Absent (some tests): `ToolSearch` is never
     * offered and the sub-agent limits are the schema defaults.
     */
    @Inject(KernelConfigService) private readonly config?: Pick<KernelConfigService, "get">,
  ) {}

  /** The kernel's builtin tools (`ToolSearch` is added by {@link forAgent}, not by definitions). */
  private get builtins(): readonly BuiltinTool[] {
    return this.builtinTools.list();
  }

  /** `host.list("connector")` 中 `kind` 匹配的第一个实现；未安装返回 undefined。 */
  findConnector(kind: string): Connector | undefined {
    for (const e of this.extensions.list("connector")) {
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
      return this.builtins.find((b) => b.spec.name === source.name)?.run;
    }
    if (source.kind === "plugin") {
      const t = this.host
        .tools()
        .find((x) => x.plugin === source.plugin && x.spec.name === source.name);
      if (!t) return undefined;
      return (input, ctx) =>
        t.inflight.run(ctx.signal, (signal) => t.handler(input, { ...ctx, signal }));
    }
    return undefined;
  }

  /** The registered builtin tools' specs (display metadata for `tools/info.ts`). */
  builtinSpecs(): ToolSpec[] {
    return this.builtins.map((b) => b.spec);
  }

  /** The loaded extensions' registered tool specs, with their extension's name. */
  extensionToolSpecs(): { plugin: string; spec: ToolSpec }[] {
    return this.host.tools().map((t) => ({ plugin: t.plugin, spec: t.spec }));
  }

  /** 已安装连接器的 kind 列表（去重，按加载顺序）。 */
  connectorKinds(): string[] {
    return [...new Set(this.extensions.list("connector").map((e) => (e.impl as Connector).kind))];
  }

  /**
   * The connector kinds `orgId` can create connectors of: the `connector@1` implementations loaded
   * on this replica whose extension is enabled in the org (the first implementation of a kind, as
   * {@link findConnector} picks it), sorted by kind.
   */
  async connectorKindsFor(orgId: string): Promise<{ kind: string; plugin: string }[]> {
    const enabled = await this.enabledPlugins(orgId);
    const out = new Map<string, string>();
    for (const e of this.extensions.list("connector")) {
      const kind = (e.impl as Connector | undefined)?.kind;
      if (typeof kind !== "string" || out.has(kind)) continue;
      out.set(kind, e.plugin);
    }
    return [...out]
      .filter(([, plugin]) => enabled.has(plugin))
      .map(([kind, plugin]) => ({ kind, plugin }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }

  /** True when `kind` is one of {@link connectorKindsFor}: loaded here and enabled in the org. */
  async connectorKindAvailable(orgId: string, kind: string): Promise<boolean> {
    return (await this.connectorKindsFor(orgId)).some((k) => k.kind === kind);
  }

  /**
   * Checks a definition's `disabledTools` on save (existence only): a builtin an agent can turn off
   * ({@link AGENT_BUILTIN_NAMES}), an extension loaded here and the tools it registered, a live
   * connector of the org and tools of its snapshot. An entry equal to one of `kept` (the current
   * version's) is not re-checked: a connector deleted or an extension uninstalled later never
   * blocks other edits. Returns `keys`: every tool key the agent could have, on or turned off (all
   * its builtins, every loaded extension's tools, every tool of the org's live connectors in any
   * status), the keys `toolPolicies` may use.
   */
  async checkDisabled(
    orgId: string,
    disabled: readonly DisabledToolRef[],
    kept: readonly DisabledToolRef[] = [],
  ): Promise<{ keys: Set<string>; issues: ToolRefIssue[] }> {
    const issues: ToolRefIssue[] = [];
    const keys = new Set<string>();
    for (const name of AGENT_BUILTIN_NAMES) keys.add(name);
    for (const name of BASH_COMPANION_TOOLS) keys.add(name);
    const pluginTools = this.host.tools();
    for (const t of pluginTools) keys.add(extensionToolKey(t.plugin, t.spec.name));
    const apps = await this.loadOrgConnectors(orgId, { includeDeleted: false });
    for (const app of apps) for (const t of app.tools) keys.add(connectorToolKey(app.slug, t.name));
    const builtins = new Set<string>(AGENT_BUILTIN_NAMES);
    const keptJson = new Set(kept.map((r) => canonicalJson(r)));
    disabled.forEach((ref, i) => {
      const path = `disabledTools.${i}`;
      if (keptJson.has(canonicalJson(ref))) return;
      if (ref.kind === "builtin") {
        if (!builtins.has(ref.name)) {
          const renamed = legacyKeySaveText(ref.name);
          issues.push({
            path,
            message:
              renamed !== null
                ? `Built-in tool ${renamed}`
                : `"${ref.name}" is not a built-in tool an agent can turn off`,
          });
        }
      } else if (ref.kind === "plugin") {
        const own = pluginTools.filter((x) => x.plugin === ref.plugin);
        if (own.length === 0) {
          issues.push({ path, message: `Extension "${ref.plugin}" has no tools` });
          return;
        }
        if (ref.tools === "all") return;
        for (const name of ref.tools) {
          if (!own.some((x) => x.spec.name === name)) {
            issues.push({
              path,
              message: `Extension tool "${extensionToolKey(ref.plugin, name)}" does not exist`,
            });
          }
        }
      } else {
        const app = apps.find((a) => a.id === ref.connectorId);
        if (!app) {
          issues.push({ path, message: `Connector "${ref.connectorId}" does not exist` });
          return;
        }
        if (ref.tools === "all") return;
        for (const name of ref.tools) {
          if (!app.tools.some((t) => t.name === name)) {
            issues.push({
              path,
              message: `Tool "${name}" does not exist in connector ${app.slug}`,
            });
          }
        }
      }
    });
    return { keys, issues };
  }

  /**
   * Resolves what the agent has (see the class comment), then decides on `ToolSearch`: the org
   * setting `toolSearch === "on"` and more than `tools.searchThresholdTools` tools or more than
   * `tools.searchThresholdTokens` estimated definition tokens; when on, the builtin `ToolSearch` is
   * appended. `skillLoad`: the log has a skills catalog snapshot (`skills_catalog`, Ruling M17) →
   * the builtin `Skill` is added (always fully loaded).
   */
  async forAgent(
    orgId: string,
    def: {
      disabledTools?: readonly DisabledToolRef[] | undefined;
      /** A sub-agent's key filter (frozen at dispatch); registry-managed tools are not filtered. */
      subagentTools?: SubagentTools | undefined;
      skillLoad?: boolean;
      /** The definition's sub-agent roster source: the `Agent` tool's description lists it. */
      subagents?: AgentDefinition["subagents"];
      /**
       * The run is a sub-agent's (it has a parent): it gets `SendMessage` (to reach its parent)
       * and `SubagentHandback` whatever its definition says (agent map spec §4.2, §4.3).
       */
      child?: boolean;
      /**
       * The run is a fork invocation's child (phase D): its final reply is the skill's report, so
       * it reaches its parent with neither tool (`SendMessage` only to its own sub-agents).
       */
      forkChild?: boolean;
      /**
       * The root conversation of the run (a sub-agent's tree root): tools whose availability
       * depends on the conversation's device (the sandbox tools) are listed by it.
       */
      sandboxConversationId?: string;
      /** An eval replay's listing: its calls are never executed (the sandbox tools are listed). */
      replay?: boolean;
      /**
       * The conversation's source (memory plugin spec §6.2): an extension tool whose
       * `spec.sources` leaves it out is hidden. Required, so nothing defaults to the widest.
       */
      source: ConversationSource;
    },
  ): Promise<AgentTools> {
    const resolved = await this.resolve(orgId, def);
    const { unavailable, hidden } = resolved;
    const tools = filterSubagentTools(resolved.tools, def.subagentTools);
    // `SendMessage` to an agent that has `Agent` (to reach its sub-agents) or a parent;
    // `SubagentHandback` to a sub-agent only; a fork invocation's child reports by its reply
    const toParent = def.child === true && def.forkChild !== true;
    const messageTools = [
      ...(toParent || tools.some((t) => t.key === AGENT_TOOL) ? [SEND_MESSAGE] : []),
      ...(toParent ? [SUBAGENT_HANDBACK] : []),
    ];
    for (const name of messageTools) {
      const b = this.builtins.find((x) => x.spec.name === name);
      if (b) tools.push(builtinTool(b, b.spec));
    }
    const sl = def.skillLoad === true && this.builtins.find((x) => x.spec.name === SKILL_LOAD);
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
      const b = this.builtins.find((x) => x.spec.name === TOOL_SEARCH) as BuiltinTool;
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

  /** 是否启用 `ToolSearch`（见 {@link forAgent}）；先比阈值，超过才读组织设置。 */
  private async searchActive(orgId: string, tools: readonly ResolvedTool[]): Promise<boolean> {
    const cfg = this.config?.get().tools;
    if (!cfg || !this.builtins.some((b) => b.spec.name === TOOL_SEARCH)) return false;
    const over =
      tools.length > cfg.searchThresholdTools ||
      estimateToolTokens(tools) > cfg.searchThresholdTokens;
    if (!over) return false;
    return (await readOrgSettings(this.db.db, orgId)).toolSearch === "on";
  }

  private async resolve(
    orgId: string,
    def: {
      disabledTools?: readonly DisabledToolRef[] | undefined;
      subagents?: AgentDefinition["subagents"];
      sandboxConversationId?: string;
      replay?: boolean;
      source: ConversationSource;
    },
  ): Promise<{ tools: ResolvedTool[]; unavailable: UnavailableTool[]; hidden: UnavailableTool[] }> {
    const disabled = def.disabledTools ?? [];
    const { source } = def;
    const scope: ToolListingScope = {
      orgId,
      ...(def.sandboxConversationId !== undefined && {
        conversationId: def.sandboxConversationId,
      }),
      ...(def.replay === true && { replay: true }),
      memo: new Map(),
    };
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

    // builtins
    for (const name of AGENT_BUILTIN_NAMES) {
      if (builtinDisabled(disabled, name)) continue;
      const b = this.builtins.find((x) => x.spec.name === name);
      if (!b) continue;
      const why = (await b.unavailable?.(scope)) ?? null;
      if (why !== null) {
        hidden.push({ ref: name, reason: why });
        continue;
      }
      // `Agent`: the description lists this definition's roster (sub-agents spec §4.3); with an
      // empty roster there is nothing to dispatch, so the tool is not offered at all
      let spec = b.spec;
      if (name === AGENT_TOOL) {
        const roster = await resolveRoster(this.db.db, orgId, { subagents: def.subagents });
        if (roster.length === 0) continue;
        spec = agentToolSpec(roster, await this.maxConcurrentSubagents(orgId));
      }
      add(builtinTool(b, spec));
      // `TaskOutput`, `TaskStop` and `TaskList` come with an available `Bash` (background Bash
      // spec §2)
      if (name === BUILTIN.Bash) {
        for (const companion of BASH_COMPANION_TOOLS) {
          const c = this.builtins.find((x) => x.spec.name === companion);
          if (c && ((await c.unavailable?.(scope)) ?? null) === null) {
            add(builtinTool(c, c.spec));
          }
        }
      }
    }

    // extension tools: the extensions enabled in the org
    const pluginTools = this.host.tools();
    if (pluginTools.length > 0) {
      const [enabledPlugins, offKeys] = await Promise.all([
        this.enabledPlugins(orgId),
        this.switches.offKeys(orgId),
      ]);
      // one effective config read per extension and resolution, however many tools it has
      const configured = new Map<string, Promise<boolean>>();
      const configuredIn = (plugin: string): Promise<boolean> => {
        let ok = configured.get(plugin);
        if (!ok) {
          ok = this.effective.get(orgId, plugin).then((e) => e.ok);
          configured.set(plugin, ok);
        }
        return ok;
      };
      for (const t of pluginTools) {
        if (!enabledPlugins.has(t.plugin)) continue;
        if (extensionToolDisabled(disabled, t.plugin, t.spec.name)) continue;
        const key = extensionToolKey(t.plugin, t.spec.name);
        // the pipeline refuses such calls too (a resumed step), this keeps them from the model
        if (offKeys.has(key)) {
          hidden.push({ ref: key, reason: toolTurnedOffReason(key) });
          continue;
        }
        // offered only in some conversation sources; the source never changes, so this also
        // refuses a resumed call (the pipeline resolves the step's tools with the same source)
        if (t.spec.sources !== undefined && !t.spec.sources.includes(source)) {
          hidden.push({ ref: key, reason: sourceHiddenReason(source) });
          continue;
        }
        if (!(await configuredIn(t.plugin))) {
          hidden.push({ ref: key, reason: `Plugin ${t.plugin} ${NEEDS_CONFIG_REASON}` });
          continue;
        }
        const issue = toolKeyIssue(key);
        if (issue) {
          hidden.push({ ref: key, reason: issue });
          continue;
        }
        add({
          key,
          source: { kind: "plugin", plugin: t.plugin, name: t.spec.name },
          spec: t.spec,
          specHash: specHash(t.spec),
          defaultPolicy: t.spec.defaultPolicy ?? policyFromAnnotations(t.spec.annotations),
        });
      }
    }

    // connector tools: the org's live connectors
    for (const app of await this.loadOrgConnectors(orgId, { includeDeleted: false })) {
      if (
        disabled.some(
          (r) => r.kind === "connector" && r.connectorId === app.id && r.tools === "all",
        )
      ) {
        continue;
      }
      const all = connectorToolKey(app.slug, "*");
      if (app.status !== "active") {
        hidden.push({ ref: all, reason: `App ${app.slug} is disabled` });
        continue;
      }
      if (!this.findConnector(app.connector)) {
        hidden.push({
          ref: all,
          reason: `Connector ${app.connector} for app ${app.slug} is not installed`,
        });
        continue;
      }
      for (const t of app.tools) {
        if (connectorToolDisabled(disabled, app.id, t.name)) continue;
        const key = connectorToolKey(app.slug, t.name);
        // 远端已不再提供（漂移检测置停用并标记，见 drift.ts）
        if (t.gone) {
          hidden.push({ ref: key, reason: `Tool no longer exists in app ${app.slug}` });
          continue;
        }
        if (t.status === "disabled") {
          hidden.push({ ref: key, reason: "Tool is disabled" });
          continue;
        }
        if (t.status === "pending_review") {
          hidden.push({ ref: key, reason: "Tool is pending review" });
          continue;
        }
        const issue = toolKeyIssue(key);
        if (issue) {
          hidden.push({ ref: key, reason: issue });
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
    return { tools, unavailable, hidden };
  }

  /**
   * `subagents.maxConcurrentPerConversation` with the organization's override, for the `Agent` tool's
   * description (§4.3). A change of the limit changes the tool's spec hash; replays read the
   * definition logged by hash, so no drift reason is involved. Without config (some tests): the
   * schema default.
   */
  private async maxConcurrentSubagents(orgId: string): Promise<number> {
    const cfg = this.config;
    const config = cfg ?? { get: () => ({ subagents: SUBAGENT_LIMIT_DEFAULTS }) };
    return (await subagentLimits(this.db.db, config, orgId)).maxConcurrentPerConversation;
  }

  /** The extensions enabled in the org (`extensions/enabled.ts`, through the host). */
  async enabledExtensions(orgId: string): Promise<Set<string>> {
    return this.host.enabledPlugins(orgId);
  }

  /** Plugins the organization enabled (built-in plugins always count as enabled, C14). */
  private async enabledPlugins(orgId: string): Promise<Set<string>> {
    return this.host.enabledPlugins(orgId);
  }

  /** The org's connectors (live ones, sorted by slug) with their tool snapshots (by name). */
  private async loadOrgConnectors(
    orgId: string,
    _opts: { includeDeleted: false },
  ): Promise<
    {
      id: string;
      slug: string;
      connector: string;
      status: "active" | "disabled";
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
    }[]
  > {
    const apps = await this.db
      .selectFrom("connectors")
      .select(["id", "slug", "connector", "status"])
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("slug")
      .orderBy("id")
      .execute();
    if (apps.length === 0) return [];
    const toolRows = await this.db
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
      .where(
        "connector_id",
        "in",
        apps.map((a) => a.id),
      )
      .orderBy("name")
      .execute();
    return apps.map((a) => ({
      id: a.id,
      slug: a.slug,
      connector: a.connector,
      status: a.status,
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
    }));
  }
}

/**
 * `tools` narrowed by a sub-agent's key filter (tools default-on spec §4): `deny` keys removed,
 * and with `allow` only its keys kept. `TaskOutput` / `TaskStop` / `TaskList` follow `Bash`, as they come with
 * it. Without a filter the list is returned as it is.
 */
export function filterSubagentTools(
  tools: ResolvedTool[],
  filter: SubagentTools | undefined,
): ResolvedTool[] {
  if (filter === undefined) return tools;
  const companions = new Set<string>(BASH_COMPANION_TOOLS);
  const deny = new Set(filter.deny ?? []);
  const allow = filter.allow === undefined ? null : new Set(filter.allow);
  const keep = (key: string): boolean => !deny.has(key) && (allow === null || allow.has(key));
  return tools.filter((t) => (companions.has(t.key) ? keep(BUILTIN.Bash) : keep(t.key)));
}
