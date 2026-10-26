import { sql } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { SANDBOX_ASK_TOOL_NAMES } from "./builtins/sandbox/names.js";
import type { AskRequest, DecidePolicy } from "./pipeline.js";
import type { ResolvedTool, ToolPolicy } from "./registry.js";

/**
 * spec 3.6 R3「有权 ≠ 已确认」固定清单上的工具 key：策略至少为 `ask`，记住的授权也不放行。
 *
 * R3 清单：发布到公共市场、安装连接器、提插件申请、改角色与成员、删除、改共享技能、改自己的指令。
 * M3 的内置工具（`ask_user`、`read_tool_output`、`tool_search`）与连接器工具都不在清单上；M5 T15 加入
 * `skill_write`（改共享技能）。后续实现上述动作的内置工具时把 key 登记在这里。连接器 / 插件工具由
 * `annotations.requiresUserInteraction` 表达同一约束。
 */
export const R3_FIXED_ASK_TOOL_KEYS: ReadonlySet<string> = new Set<string>(["skill_write"]);

/**
 * R3 清单里只对共享 agent 生效的 key（窄口子）：R3 的条目是「改共享技能」，私有 agent（`visibility = private`，
 * 只有负责人本人能用）的技能不是共享的，`skill_write` 直接生效、不询问（R4）。其余 R3 条目不论可见性一律固定 ask。
 */
export const R3_SHARED_AGENT_ONLY_TOOL_KEYS: ReadonlySet<string> = new Set<string>(["skill_write"]);

const RANK: Record<ToolPolicy, number> = { allow: 0, ask: 1, deny: 2 };

/** 取更严的策略（`allow < ask < deny`）。 */
export function stricter(a: ToolPolicy, b: ToolPolicy | undefined): ToolPolicy {
  return b !== undefined && RANK[b] > RANK[a] ? b : a;
}

export interface PolicyInput {
  /** 组织默认：`connector_tools.default_policy`，插件 / 内置工具为其声明（或注解推导）的默认。 */
  connectorDefault: ToolPolicy;
  /** agent 负责人的收紧（`definition.toolPolicies[key]`）。 */
  agentOverride?: "ask" | "deny";
  /** R3 清单或 `requiresUserInteraction`。 */
  fixedAsk: boolean;
  /** 已记住且 specHash 与当前一致的授权。 */
  grant: "session" | "always" | null;
}

/**
 * 策略判定（纯函数）：取组织默认、agent 收紧、R3 固定询问三者中最严者；
 * 记住的授权只能把 `ask` 放行为 `allow`，不能越过 `deny`，对 R3 / `requiresUserInteraction` 的工具无效。
 */
export function decide(input: PolicyInput): ToolPolicy {
  let p = stricter(input.connectorDefault, input.agentOverride);
  if (input.fixedAsk) p = stricter(p, "ask");
  if (p === "ask" && input.grant !== null && !input.fixedAsk) return "allow";
  return p;
}

/**
 * 是否属于 R3 固定询问（清单或工具声明需要用户交互）。`visibility` 为 agent 当前的可见性：
 * {@link R3_SHARED_AGENT_ONLY_TOOL_KEYS} 里的内置工具在私有 agent 上不算固定询问，
 * 除非 agent 当前版本的 `skills.writePolicy` 为 `ask`（`skillWritePolicy`）；不知道可见性时按共享处理（更严）。
 */
export function isFixedAsk(
  tool: ResolvedTool,
  visibility?: "private" | "org" | "members" | undefined,
  skillWritePolicy?: "allow" | "ask" | undefined,
): boolean {
  if (tool.spec.annotations?.requiresUserInteraction === true) return true;
  if (!R3_FIXED_ASK_TOOL_KEYS.has(tool.key)) return false;
  const builtinOnly =
    tool.source.kind === "builtin" && R3_SHARED_AGENT_ONLY_TOOL_KEYS.has(tool.key);
  // 私有 agent：缺省 / allow 不问（R4），负责人设为 ask（D10）时与共享 agent 一样固定询问
  return !(builtinOnly && visibility === "private" && skillWritePolicy !== "ask");
}

const asOverride = (v: unknown): "ask" | "deny" | undefined =>
  v === "ask" || v === "deny" ? v : undefined;

/**
 * 执行时的策略判定（spec 3.6 R5：在动作执行那一刻判定）。每次调用都实时读取：
 * - 沙箱工具（bash / write / edit / deliver）的组织设置 `sandboxToolPolicy`（为 ask 时组织默认至少 ask）；
 * - 连接器工具的 `connector_tools.default_policy` / 状态 / 指纹（连接器或工具已不存在、停用、删除、待审核 →
 *   `{ unavailable: 原因 }`，管线写「工具不可用」的事实说明，而非策略拒绝）；
 * - agent 当前版本的 `toolPolicies`，与运行所用版本取更严者（负责人运行中收紧立即生效；放宽不影响已在跑的运行）；
 * - a sub-agent (template or general-purpose): `agentDef` is its frozen effective definition (the
 *   parent's policies with the template's on top) and `ctx.agentId` is the parent's agent, so the
 *   parent's current version still tightens it (sub-agents spec §5.3, §9); its "this conversation"
 *   grants are the parent conversation's; an org agent sub-agent (§5.5): `ctx.agentId` is the
 *   dispatched agent (its current version, its "always" grants) and the parent agent's current
 *   policies apply on top ({@link parentAgentOverride});
 * - 授权表（`conversation_tool_grants` / `tool_grants`），`spec_hash` 与当前定义不一致视为无效（D8），
 *   `connector_id` 与工具的来源连接器不一致也无效（删除后用同一 slug 重新安装的连接器不继承旧授权）；
 * - 工具声明了 `requiredRole`（R1）时，发起人在组织中的当前角色：不是成员 → 拒绝；角色不足 → 按角色升级的审批
 *   （`approverRole` = 所需角色、`requestedFor` = null），此时记住的授权不放行。
 *
 * 结果为 `ask` 时返回审批请求，默认指向发起人本人；记住的授权把 `ask` 放行时返回 `{ grant }`（按 allow 执行）。
 */
export function createDecidePolicy(db: KernelDb): DecidePolicy {
  return async (tool, agentDef, ctx) => {
    let connectorDefault: ToolPolicy = tool.defaultPolicy;
    let connectorId: string | null = null;
    let hashCurrent = true;
    if (tool.source.kind === "connector") {
      connectorId = tool.source.connectorId;
      const app = await db
        .selectFrom("connectors")
        .select(["slug", "status", "deleted_at"])
        .where("id", "=", tool.source.connectorId)
        .where("org_id", "=", ctx.orgId)
        .executeTakeFirst();
      // 调用那一刻连接器 / 工具已不可用：给事实原因（与注册表的不可用说明一致），不说成「策略拒绝」
      if (!app) return { unavailable: "App does not exist" };
      if (app.deleted_at !== null) return { unavailable: `App ${app.slug} was deleted` };
      if (app.status !== "active") return { unavailable: `App ${app.slug} is disabled` };
      const row = await db
        .selectFrom("connector_tools")
        .select(["default_policy", "spec_hash", "status", "missing_since"])
        .where("connector_id", "=", tool.source.connectorId)
        .where("name", "=", tool.source.name)
        .executeTakeFirst();
      if (!row || row.missing_since !== null) {
        return { unavailable: `Tool no longer exists in app ${app.slug}` };
      }
      if (row.status === "disabled") return { unavailable: "Tool is disabled" };
      if (row.status !== "enabled") return { unavailable: "Tool is pending review" };
      connectorDefault = row.default_policy;
      hashCurrent = row.spec_hash === tool.specHash;
    }
    // 沙箱工具的组织默认（M5 T8）：组织设置 sandboxToolPolicy 为 ask 时，有副作用的沙箱工具至少 ask
    if (tool.source.kind === "builtin" && SANDBOX_ASK_TOOL_NAMES.has(tool.source.name)) {
      if ((await readOrgSettings(db, ctx.orgId)).sandboxToolPolicy === "ask") {
        connectorDefault = stricter(connectorDefault, "ask");
      }
    }

    // 运行所用版本可能是加 toolPolicies 字段之前保存的：缺省为空
    const runOverride = asOverride(
      (agentDef.toolPolicies as Record<string, unknown> | undefined)?.[tool.key],
    );
    const current = await db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select(["agent_versions.definition", "agents.visibility"])
      .where("agents.id", "=", ctx.agentId)
      .executeTakeFirst();
    const currentPolicies = (
      current?.definition as { toolPolicies?: Record<string, unknown> } | undefined
    )?.toolPolicies;
    const currentOverride = asOverride(currentPolicies?.[tool.key]);
    let strictest = stricter(runOverride ?? "allow", currentOverride);
    if (ctx.parentConversationId !== undefined && ctx.parentAgentDiffers !== false) {
      strictest = stricter(strictest, await parentAgentOverride(db, tool.key, ctx));
    }
    const agentOverride = strictest === "allow" ? undefined : strictest;

    let escalateTo: OrgRole | null = null;
    if (tool.requiredRole !== undefined) {
      const m = await db
        .selectFrom("memberships")
        .select("role")
        .where("org_id", "=", ctx.orgId)
        .where("account_id", "=", ctx.accountId)
        .executeTakeFirst();
      if (!m) return "deny";
      if (!roleAtLeast(m.role, tool.requiredRole)) escalateTo = tool.requiredRole;
    }

    // 可见性实时读（R5）：共享 agent 的 skill_write 固定 ask，私有 agent 不问（见 R3_SHARED_AGENT_ONLY_TOOL_KEYS）
    // 当前版本的 skills.writePolicy 同样实时读（R5）：运行中改为 ask，下一次调用即生效；固定 ask 时授权不放行
    const writePolicy = (current?.definition as AgentDefinition | undefined)?.skills?.writePolicy;
    const fixedAsk = isFixedAsk(tool, current?.visibility, writePolicy);
    const input: PolicyInput = {
      connectorDefault,
      ...(agentOverride !== undefined && { agentOverride }),
      fixedAsk,
      grant: null,
    };
    const pre = decide(input);
    if (pre === "deny") return "deny";
    if (pre === "ask" && !fixedAsk && escalateTo === null && hashCurrent) {
      input.grant = await findGrant(db, tool, connectorId, ctx);
    }
    const result = decide(input);
    if (result === "allow" && escalateTo === null) {
      // 记住的授权把 ask 放行：返回授权种类（审计链记录凭什么放行）
      return pre === "ask" && input.grant !== null ? { grant: input.grant } : "allow";
    }
    const ask: AskRequest = {
      toolKey: tool.key,
      specHash: tool.specHash,
      connectorId,
      requestedFor: escalateTo === null ? ctx.accountId : null,
      approverRole: escalateTo,
    };
    return { ask };
  };
}

/**
 * An org agent sub-agent (sub-agents spec §5.5, §9): its conversation's agent is the dispatched
 * agent, so `ctx.agentId`'s current version above is that agent's; the parent agent's current
 * policy for the same key applies on top, so the parent's owner can tighten a running child too.
 * For a template or general-purpose child the parent conversation has the same agent, already read.
 */
async function parentAgentOverride(
  db: KernelDb,
  toolKey: string,
  ctx: { agentId: string; parentConversationId?: string },
): Promise<"ask" | "deny" | undefined> {
  const row = await db
    .selectFrom("conversations as c")
    .innerJoin("agents as a", "a.id", "c.agent_id")
    .innerJoin("agent_versions as v", (j) =>
      j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
    )
    .select(["a.id", "v.definition"])
    .where("c.id", "=", ctx.parentConversationId ?? "")
    .executeTakeFirst();
  if (!row || row.id === ctx.agentId) return undefined;
  const policies = (row.definition as { toolPolicies?: Record<string, unknown> }).toolPolicies;
  return asOverride(policies?.[toolKey]);
}

/**
 * A grant matching the current definition hash and source connector: this conversation's first,
 * then "always". `connectorId` is the tool's source connector (null for plugin and builtin tools,
 * which match only grants without a connector). A sub-agent's "this conversation" grants live on
 * its parent conversation (sub-agents spec §9), so parallel children are approved once.
 */
async function findGrant(
  db: KernelDb,
  tool: ResolvedTool,
  connectorId: string | null,
  ctx: {
    orgId: string;
    accountId: string;
    agentId: string;
    conversationId: string;
    parentConversationId?: string;
  },
): Promise<"session" | "always" | null> {
  const sameConnector = sql<boolean>`connector_id IS NOT DISTINCT FROM ${connectorId}`;
  const session = await db
    .selectFrom("conversation_tool_grants")
    .select("spec_hash")
    .where("conversation_id", "=", ctx.parentConversationId ?? ctx.conversationId)
    .where("tool_key", "=", tool.key)
    .where(sameConnector)
    .executeTakeFirst();
  if (session?.spec_hash === tool.specHash) return "session";
  const always = await db
    .selectFrom("tool_grants")
    .select("spec_hash")
    .where("org_id", "=", ctx.orgId)
    .where("account_id", "=", ctx.accountId)
    .where("agent_id", "=", ctx.agentId)
    .where("tool_key", "=", tool.key)
    .where(sameConnector)
    .executeTakeFirst();
  return always?.spec_hash === tool.specHash ? "always" : null;
}
