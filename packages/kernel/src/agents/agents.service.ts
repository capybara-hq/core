import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { cancelEvalRuns } from "../evals/budget.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";
import type { KernelLogger } from "../log.js";
import { rejectAnonymousGuest } from "../orgs/members.service.js";
import { OrgLock } from "../orgs/org-lock.js";
import { roleAtLeast } from "../orgs/roles.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { SkillChangesService } from "../skills/changes.service.js";
import { assertOrgSkills, assertPinnedSkills } from "../skills/skills.service.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  AgentLookup,
  type AgentView,
  type AgentVisibility,
  isAgentVisibleTo,
  visibleTo,
} from "./agent-lookup.js";
import {
  type AgentDefinition,
  normalizeStoredDefinition,
  paramIssues,
  SUBAGENT_NAME_RE,
  SUBAGENT_ROSTER_MAX,
} from "./definition.js";

export {
  AGENT_VISIBILITIES,
  type AgentView,
  type AgentVisibility,
  isAgentVisibleTo,
  visibleTo,
} from "./agent-lookup.js";
export { paramIssues, SUBAGENT_ROSTER_MAX } from "./definition.js";

/** 删除 agent 时每个销毁任务带的对话数。 */
const SANDBOX_DESTROY_BATCH = 500;
export interface AgentVersion {
  version: number;
  definition: AgentDefinition;
  createdBy: string;
  createdAt: Date;
}

export type AgentVersionSummary = Omit<AgentVersion, "definition">;

/** 创建 / 修改的提示（不拒绝）：`fallback_same_provider` = 兜底与主模型同一供应商（spec 4.5）。 */
export type AgentWarning = "fallback_same_provider";

const notFound = () => new ApiError("agent.not_found", "Agent not found");

/** 键排序后的 JSON：jsonb 不保留键顺序，比较定义是否变化时用。 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Why a `subagents` block is refused (`agent.subagents_invalid` details). */
export type SubagentsProblem =
  | "not_found"
  | "invalid_name"
  | "duplicate"
  | "tool_not_selected"
  | "skill_not_selected"
  | "agent_not_available"
  | "self"
  | "too_many";

/**
 * Checks `subagents` of an agent definition in the caller's transaction (spec §5.2); throws 400
 * `agent.subagents_invalid` with one detail per problem (`{ reason, path, value? }`):
 * - `not_found`: a template id that is not a live agent template of the org;
 * - `invalid_name`: an inline name or `agents[].as` outside {@link SUBAGENT_NAME_RE}, or
 *   `general-purpose`; `duplicate`: a roster type listed twice (a template id twice included);
 * - `tool_not_selected`: an inline template's `tools`, `disallowedTools` or `toolPolicies` key that
 *   is not a tool key of this agent (`toolKeys`, from `ToolRegistry.checkRefs`);
 * - `skill_not_selected`: an inline skill id that is neither in `skills.orgSkills` nor a live
 *   skill of this agent;
 * - `self`: this agent allowlisted; `agent_not_available`: an allowlisted agent that is not a live
 *   agent of the org visible to the person saving with `subagents.dispatchable: true` in its
 *   current version;
 * - `too_many`: more than {@link SUBAGENT_ROSTER_MAX} roster entries.
 * Template ids and allowlisted agents already in the current version (`kept`) are not re-checked
 * for `not_found` / `agent_not_available`: a template uninstalled or an agent switched off later
 * does not block other edits (the dispatch refuses it at run time).
 */
export async function assertSubagents(
  t: KernelSchemaDb,
  a: {
    orgId: string;
    agentId: string | null;
    actorAccountId: string;
    definition: AgentDefinition;
    toolKeys: ReadonlySet<string>;
    kept?: AgentDefinition["subagents"];
  },
): Promise<void> {
  const sub = a.definition.subagents;
  if (sub === undefined) return;
  const details: { reason: SubagentsProblem; path: string; value?: string }[] = [];
  const add = (reason: SubagentsProblem, path: string, value?: string): void => {
    details.push({ reason, path, ...(value !== undefined && { value }) });
  };
  const types = new Set<string>(sub.general === false ? [] : ["general-purpose"]);
  const claim = (type: string, path: string) => {
    if (types.has(type)) add("duplicate", path, type);
    types.add(type);
  };
  const name = (value: string, path: string) => {
    if (!SUBAGENT_NAME_RE.test(value) || value === "general-purpose") {
      add("invalid_name", path, value);
      return;
    }
    claim(value, path);
  };

  const templates = sub.templates ?? [];
  const keptTemplates = new Set(a.kept?.templates ?? []);
  const ids = [...new Set(templates)];
  // every listed template, deleted ones included (a kept one may have been uninstalled since)
  const rows = new Map(
    ids.length === 0
      ? []
      : (
          await t
            .selectFrom("agent_templates")
            .select(["id", "name", "plugin_name", "deleted_at"])
            .where("org_id", "=", a.orgId)
            .where("id", "in", ids)
            .execute()
        ).map((r) => [r.id, r]),
  );
  templates.forEach((id, i) => {
    const path = `subagents.templates.${i}`;
    const row = rows.get(id);
    if (!keptTemplates.has(id) && (row === undefined || row.deleted_at !== null)) {
      add("not_found", path, id);
      return;
    }
    // claimed by its roster type (`<plugin>:<name>`, roster.ts templateType), so nothing shadows it
    claim(row === undefined ? `template:${id}` : `${row.plugin_name}:${row.name}`, path);
  });

  const inline = sub.inline ?? [];
  const selected = new Set(a.definition.skills?.orgSkills ?? []);
  const skillIds = [...new Set(inline.flatMap((x) => x.skills ?? []))].filter(
    (id) => !selected.has(id),
  );
  const own =
    a.agentId === null || skillIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await t
              .selectFrom("skills")
              .select("id")
              .where("org_id", "=", a.orgId)
              .where("scope", "=", "agent")
              .where("agent_id", "=", a.agentId)
              .where("deleted_at", "is", null)
              .where("id", "in", skillIds)
              .execute()
          ).map((r) => r.id),
        );
  inline.forEach((x, i) => {
    const base = `subagents.inline.${i}`;
    name(x.name, `${base}.name`);
    const tool = (key: string, path: string) => {
      if (!a.toolKeys.has(key)) add("tool_not_selected", path, key);
    };
    for (const [j, key] of (x.tools ?? []).entries()) tool(key, `${base}.tools.${j}`);
    for (const [j, key] of (x.disallowedTools ?? []).entries()) {
      tool(key, `${base}.disallowedTools.${j}`);
    }
    for (const key of Object.keys(x.toolPolicies ?? {})) tool(key, `${base}.toolPolicies.${key}`);
    (x.skills ?? []).forEach((id, j) => {
      if (!selected.has(id) && !own.has(id)) add("skill_not_selected", `${base}.skills.${j}`, id);
    });
  });

  const keptAgents = new Set((a.kept?.agents ?? []).map((x) => x.agentId));
  for (const [i, x] of (sub.agents ?? []).entries()) {
    const base = `subagents.agents.${i}`;
    name(x.as, `${base}.as`);
    if (x.agentId === a.agentId) {
      add("self", `${base}.agentId`, x.agentId);
      continue;
    }
    if (keptAgents.has(x.agentId)) continue;
    const row = await t
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select("agent_versions.definition")
      .where("agents.id", "=", x.agentId)
      .where("agents.org_id", "=", a.orgId)
      .where("agents.deleted_at", "is", null)
      .executeTakeFirst();
    const dispatchable =
      (row?.definition as AgentDefinition | undefined)?.subagents?.dispatchable === true;
    if (!dispatchable || !(await isAgentVisibleTo(t, x.agentId, a.actorAccountId))) {
      add("agent_not_available", `${base}.agentId`, x.agentId);
    }
  }

  const count =
    (sub.general === false ? 0 : 1) + templates.length + inline.length + (sub.agents?.length ?? 0);
  if (count > SUBAGENT_ROSTER_MAX) add("too_many", "subagents");
  if (details.length > 0) {
    throw new ApiError(
      "agent.subagents_invalid",
      `Invalid sub-agents: ${details.map((d) => `${d.path} (${d.reason})`).join(", ")}`,
      details,
    );
  }
}

/**
 * Agent 定义、版本与可见范围。写操作都在组织行锁内实时复核发起人角色（spec 3.6 R5）；
 * 服务只接收发起人账号 id。不可见的 agent 一律 `agent.not_found`。
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AgentLookup) private readonly lookup: AgentLookup,
    @Inject(ToolRegistry) private readonly tools: Pick<ToolRegistry, "checkRefs">,
    /** 删除 agent 时取消它待处理的技能改动（T15）。 */
    @Inject(SkillChangesService)
    private readonly skillChanges: Pick<
      SkillChangesService,
      "cancelPendingForAgent" | "finishCancel"
    >,
    /** The org row lock (orgs/org-lock.ts; R12): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    /** Resolves the agent's models (and their parameter declarations) when it is saved. */
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    /**
     * R7: the sandbox destruction after a delete (内核投递一次性维护任务 `sandbox-destroy-for`，worker
     * 在锁内逐个销毁，幂等; Task 3.8).
     */
    @Inject(LegacyPorts) private readonly ports: LegacyPorts,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * 校验工具引用与工具策略：引用的内置 / 插件 / 连接器工具必须存在（见 `ToolRegistry.checkRefs`）；
   * `toolPolicies` 的键必须是这些引用产生的工具 key（取值只能收紧，已由 schema 保证）。
   * 不合法 → `validation_failed`，path 为 `tools.<i>` / `toolPolicies.<key>`。
   */
  private async checkTools(orgId: string, def: AgentDefinition): Promise<Set<string>> {
    const { keys, issues } = await this.tools.checkRefs(orgId, def.tools);
    const details = [...issues];
    for (const key of Object.keys(def.toolPolicies)) {
      if (!keys.has(key)) {
        details.push({
          path: `toolPolicies.${key}`,
          message: `"${key}" is not a tool of this agent`,
        });
      }
    }
    if (details.length > 0) {
      throw new ApiError("validation_failed", "Invalid tool references", details);
    }
    return keys;
  }

  /**
   * 校验主模型与兜底都可解析，并用各自模型的参数声明严格校验 `modelParams` / `fallbackParams`
   * （没有兜底时 `fallbackParams` 必须为空）；不合法 → `validation_failed`，details 逐键点名。返回提示。
   */
  private async checkModels(def: AgentDefinition): Promise<AgentWarning[]> {
    const registry = this.providers;
    const main = await registry.resolve(def.model);
    const fallback = def.fallback === null ? null : await registry.resolve(def.fallback);
    const details = [
      ...paramIssues("modelParams", main.info.parameters, def.modelParams),
      ...paramIssues("fallbackParams", fallback?.info.parameters ?? [], def.fallbackParams),
    ];
    if (details.length > 0) {
      throw new ApiError("validation_failed", "Invalid model parameters", details);
    }
    if (def.fallback === null) return [];
    return def.fallback.provider === def.model.provider ? ["fallback_same_provider"] : [];
  }

  /** 名单里的账号必须都是该组织当前成员，否则 `member.not_found`；返回去重后的 id。 */
  private async checkMembers(t: KernelSchemaDb, orgId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    const found = await t
      .selectFrom("memberships")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("account_id", "in", unique)
      .execute();
    if (found.length !== unique.length) {
      throw new ApiError("member.not_found", "Agent member is not a member of the organization");
    }
    return unique;
  }

  private async setMembers(t: KernelSchemaDb, agentId: string, ids: string[]): Promise<void> {
    await t.deleteFrom("agent_members").where("agent_id", "=", agentId).execute();
    if (ids.length > 0) {
      await t
        .insertInto("agent_members")
        .values(ids.map((account_id) => ({ agent_id: agentId, account_id })))
        .execute();
    }
  }

  /**
   * 新建 agent（版本 1）：在组织行锁内授权 `agents.create`；主模型与兜底都必须可解析
   * （`agent.model_unavailable`）；兜底与主模型同一供应商只提示 `fallback_same_provider`。
   */
  async create(
    orgId: string,
    actorAccountId: string,
    input: { definition: AgentDefinition; visibility: AgentVisibility; memberIds?: string[] },
    actorTokenId?: string,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    // 先解析模型（可能访问供应商），不在持有组织行锁时做
    const warnings = await this.checkModels(input.definition);
    const toolKeys = await this.checkTools(orgId, input.definition);
    if (input.visibility !== "members" && (input.memberIds?.length ?? 0) > 0) {
      throw new ApiError("validation_failed", "memberIds requires visibility 'members'");
    }
    const agent = await this.createIn(orgId, actorAccountId, input, toolKeys, actorTokenId);
    return { agent, warnings };
  }

  @Transactional()
  private async createIn(
    orgId: string,
    actorAccountId: string,
    input: { definition: AgentDefinition; visibility: AgentVisibility; memberIds?: string[] },
    toolKeys: Set<string>,
    actorTokenId: string | undefined,
  ): Promise<AgentView> {
    const t = this.db.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "agents.create");
    await assertOrgSkills(t, orgId, input.definition.skills?.orgSkills ?? []);
    await assertPinnedSkills(t, orgId, null, input.definition.skills);
    await assertSubagents(t, {
      orgId,
      agentId: null,
      actorAccountId,
      definition: input.definition,
      toolKeys,
    });
    const memberIds =
      input.visibility === "members"
        ? await this.checkMembers(t, orgId, input.memberIds ?? [])
        : [];
    const id = randomUUID();
    await t
      .insertInto("agents")
      .values({
        id,
        org_id: orgId,
        owner_account_id: actorAccountId,
        visibility: input.visibility,
        current_version: 1,
      })
      .execute();
    await t
      .insertInto("agent_versions")
      .values({
        agent_id: id,
        version: 1,
        definition: JSON.stringify(input.definition),
        created_by: actorAccountId,
      })
      .execute();
    await this.setMembers(t, id, memberIds);
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.created",
      target: id,
      detail: { version: 1, visibility: input.visibility },
    });
    return this.lookup.view(id);
  }

  /**
   * 锁组织行并复核发起人，再锁 agent 行：发起人须仍具备 `agents.create`（member 以上），且是负责人或组织管理员以上；
   * 对发起人不可见的 agent（非管理员）→ `agent.not_found`，可见但无权 → `forbidden`。
   */
  @Transactional({ propagation: "mandatory" })
  private async lockForWrite(
    orgId: string,
    agentId: string,
    actorAccountId: string,
  ): Promise<{ visibility: AgentVisibility; current_version: number }> {
    const t = this.db.db;
    const { role } = await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "agents.create");
    // NO KEY UPDATE: a soft delete then appends revert snapshots to conversations; FOR UPDATE would
    // block the agent foreign key check of an append already holding one of them (40P01)
    const agent = await t
      .selectFrom("agents")
      .select(["owner_account_id", "visibility", "current_version"])
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!agent) throw notFound();
    if (agent.owner_account_id === actorAccountId || roleAtLeast(role, "admin")) return agent;
    const visible = await t
      .selectFrom("agents")
      .select("id")
      .where("id", "=", agentId)
      .where(visibleTo(actorAccountId))
      .executeTakeFirst();
    if (!visible) throw notFound();
    throw new ApiError("forbidden", "Only the agent owner or an organization admin can modify it");
  }

  /**
   * 修改 agent：`definition` 变化时写新版本（`current_version + 1`），只改 visibility / memberIds 不产生新版本。
   * 只有负责人或组织管理员以上可改，在组织行锁内复核。
   */
  async update(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    patch: {
      definition?: AgentDefinition | undefined;
      visibility?: AgentVisibility | undefined;
      memberIds?: string[] | undefined;
      /**
       * 给出且不等于当前版本 → `agent.version_conflict`（409），在锁内判定。只比定义版本：只改可见范围 / 成员
       * 不产生新版本，所以检测不到别人只改了可见范围（之后的保存会按本次给出的 visibility 覆盖）。
       */
      expectedVersion?: number | undefined;
    },
    actorTokenId?: string,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const warnings = patch.definition ? await this.checkModels(patch.definition) : [];
    const toolKeys = patch.definition ? await this.checkTools(orgId, patch.definition) : null;
    const agent = await this.updateIn(
      orgId,
      agentId,
      actorAccountId,
      patch,
      toolKeys,
      actorTokenId,
    );
    return { agent, warnings };
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    patch: {
      definition?: AgentDefinition | undefined;
      visibility?: AgentVisibility | undefined;
      memberIds?: string[] | undefined;
      expectedVersion?: number | undefined;
    },
    toolKeys: Set<string> | null,
    actorTokenId: string | undefined,
  ): Promise<AgentView> {
    const t = this.db.db;
    const before = await this.lockForWrite(orgId, agentId, actorAccountId);
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== before.current_version) {
      throw new ApiError(
        "agent.version_conflict",
        `The agent was changed by someone else (now version ${before.current_version}, expected ${patch.expectedVersion}); reload it and apply your changes again`,
      );
    }
    const visibility = patch.visibility ?? before.visibility;
    if (visibility !== "members" && (patch.memberIds?.length ?? 0) > 0) {
      throw new ApiError("validation_failed", "memberIds requires visibility 'members'");
    }

    let toVersion = before.current_version;
    if (patch.definition) {
      const current = await t
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .where("version", "=", before.current_version)
        .executeTakeFirstOrThrow();
      // 当前版本已有的技能引用保存时合法，不再核对（被删的技能不挡住其他改动）；新加的照常核对
      const kept = new Set((current.definition as AgentDefinition).skills?.orgSkills ?? []);
      await assertOrgSkills(t, orgId, patch.definition.skills?.orgSkills ?? [], kept);
      await assertPinnedSkills(
        t,
        orgId,
        agentId,
        patch.definition.skills,
        (current.definition as AgentDefinition).skills?.pinned ?? [],
      );
      await assertSubagents(t, {
        orgId,
        agentId,
        actorAccountId,
        definition: patch.definition,
        toolKeys: toolKeys ?? new Set(),
        kept: (current.definition as AgentDefinition).subagents,
      });
      if (canonical(current.definition) !== canonical(patch.definition)) {
        toVersion = before.current_version + 1;
        await t
          .insertInto("agent_versions")
          .values({
            agent_id: agentId,
            version: toVersion,
            definition: JSON.stringify(patch.definition),
            created_by: actorAccountId,
          })
          .execute();
      }
    }

    if (visibility !== "members") {
      await this.setMembers(t, agentId, []);
    } else if (patch.memberIds !== undefined) {
      await this.setMembers(t, agentId, await this.checkMembers(t, orgId, patch.memberIds));
    }

    await t
      .updateTable("agents")
      .set({ visibility, current_version: toVersion, updated_at: sql`now()` })
      .where("id", "=", agentId)
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.updated",
      target: agentId,
      detail: {
        fromVersion: before.current_version,
        toVersion,
        ...(visibility !== before.visibility && {
          visibility: { from: before.visibility, to: visibility },
        }),
      },
    });
    return this.lookup.view(agentId);
  }

  /** 软删除：权限同 update。待处理的技能改动与该 agent 评测集在执行的评测运行一并取消，提交后删除草稿（T15）。 */
  async softDelete(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    const cancelled = await this.softDeleteIn(orgId, agentId, actorAccountId, actorTokenId);
    await this.skillChanges.finishCancel(orgId, cancelled);
    await this.destroySandboxes(orgId, agentId);
  }

  @Transactional()
  private async softDeleteIn(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    actorTokenId: string | undefined,
  ) {
    const t = this.db.db;
    await this.lockForWrite(orgId, agentId, actorAccountId);
    await t
      .updateTable("agents")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", agentId)
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.deleted",
      target: agentId,
    });
    // 评测集的 agent 删除后其评测运行不再花钱：显式取消（审计带原因）
    await cancelEvalRuns(
      t,
      { orgId, agentId },
      { accountId: actorAccountId, ...(actorTokenId !== undefined && { tokenId: actorTokenId }) },
      "agent_deleted",
    );
    // joins this transaction (mandatory: it relies on the agent row lock taken above)
    return this.skillChanges.cancelPendingForAgent(
      orgId,
      agentId,
      actorAccountId,
      "agent_deleted",
      actorTokenId,
    );
  }

  /** 提交后尽力而为：投递销毁这个 agent 各对话还没销毁的沙箱（失败只记日志，留给不活跃销毁扫描）。 */
  private async destroySandboxes(orgId: string, agentId: string): Promise<void> {
    try {
      const rows = await this.db
        .selectFrom("sandboxes as s")
        .innerJoin("conversations as c", "c.id", "s.conversation_id")
        .select("s.conversation_id")
        .where("c.org_id", "=", orgId)
        .where("c.agent_id", "=", agentId)
        .where("s.status", "<>", "destroyed")
        .execute();
      const ids = rows.map((r) => r.conversation_id);
      for (let i = 0; i < ids.length; i += SANDBOX_DESTROY_BATCH) {
        await this.ports.sandboxDestroy.destroy(ids.slice(i, i + SANDBOX_DESTROY_BATCH));
      }
    } catch (err) {
      this.log.warn("cannot schedule sandbox destruction for a deleted agent", { agentId, err });
    }
  }

  /**
   * 重新指派负责人（`agents.manage`，admin）：在组织行锁内授权；agent 不存在 / 已删除 → `agent.not_found`；
   * 新负责人不是该组织成员 → `member.not_found`；是匿名访客 → `member.anonymous_guest`。
   * 清除 `needs_reassignment`，审计 `agent.owner_changed`。
   */
  @Transactional()
  async reassignOwner(
    orgId: string,
    agentId: string,
    newOwnerId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<AgentView> {
    const t = this.db.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "agents.manage");
    const agent = await t
      .selectFrom("agents")
      .select(["owner_account_id", "needs_reassignment"])
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!agent) throw notFound();
    const member = await t
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", newOwnerId)
      .executeTakeFirst();
    if (!member) throw new ApiError("member.not_found", "Member not found");
    await rejectAnonymousGuest(t, newOwnerId);
    await t
      .updateTable("agents")
      .set({ owner_account_id: newOwnerId, needs_reassignment: false, updated_at: sql`now()` })
      .where("id", "=", agentId)
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.owner_changed",
      target: agentId,
      detail: {
        from: agent.owner_account_id,
        to: newOwnerId,
        neededReassignment: agent.needs_reassignment,
      },
    });
    return this.lookup.view(agentId);
  }

  /** 取对 viewer 可见的 agent；`viewerAccountId = null` 表示该组织的服务令牌。不可见 → `agent.not_found`。 */
  get(orgId: string, agentId: string, viewerAccountId: string | null): Promise<AgentView> {
    return this.lookup.get(orgId, agentId, viewerAccountId);
  }

  /** 组织内对 viewer 可见的全部 agent（按创建时间）。 */
  listVisible(orgId: string, viewerAccountId: string | null): Promise<AgentView[]> {
    return this.lookup.listVisible(orgId, viewerAccountId);
  }

  /** 读某个版本（不做可见性判定，调用方负责）；不存在 → `agent.not_found`。 */
  async getVersion(agentId: string, version: number): Promise<AgentVersion> {
    const r = await this.db
      .selectFrom("agent_versions")
      .select(["version", "definition", "created_by", "created_at"])
      .where("agent_id", "=", agentId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!r) throw notFound();
    return {
      version: r.version,
      definition: normalizeStoredDefinition(r.definition),
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  /** 版本列表，新的在前（不做可见性判定，调用方负责）。 */
  async listVersions(agentId: string): Promise<AgentVersionSummary[]> {
    const rows = await this.db
      .selectFrom("agent_versions")
      .select(["version", "created_by", "created_at"])
      .where("agent_id", "=", agentId)
      .orderBy("version", "desc")
      .execute();
    return rows.map((r) => ({
      version: r.version,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }
}
