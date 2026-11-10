import { randomUUID } from "node:crypto";
import { parseToolKey } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { EvalBudget } from "../evals/budget.js";
import { audit } from "../identity/audit.js";
import type { WriteActor } from "../identity/write-actor.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { rejectAnonymousGuest } from "../orgs/members.service.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { SkillChangesService } from "../skills/changes.service.js";
import { assertOrgSkills, assertPinnedSkills } from "../skills/skills.service.js";
import { legacyKeySaveText } from "../tools/legacy-keys.js";
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
  canonicalDisabledTools,
  type DisabledToolRef,
  normalizeStoredDefinition,
  type PendingConnector,
  paramIssues,
  SUBAGENT_NAME_RE,
  SUBAGENT_ROSTER_MAX,
} from "./definition.js";
import { type AgentDefinitionInput, deriveInstructions } from "./instruction-files.js";
import { PendingConnectorRequests } from "./pending-connector-requests.js";
import { type ProfileInput, randomPreset } from "./profile.js";
import { loadTemplates, templateTypeOf } from "./templates.js";

export {
  AGENT_VISIBILITIES,
  type AgentView,
  type AgentVisibility,
  isAgentVisibleTo,
  visibleTo,
} from "./agent-lookup.js";
export { paramIssues, SUBAGENT_ROSTER_MAX } from "./definition.js";

export interface AgentVersion {
  version: number;
  definition: AgentDefinition;
  createdBy: string;
  createdAt: Date;
}

export type AgentVersionSummary = Omit<AgentVersion, "definition">;

/** 创建 / 修改的提示（不拒绝）：`fallback_same_provider` = 兜底与主模型同一供应商（spec 4.5）。 */
export type AgentWarning = "fallback_same_provider";

/**
 * The definition with its description (run context spec §3.5): `given` when the save gives one
 * (trimmed; empty removes it), else `kept` (the current version's).
 */
function withDescription(
  definition: AgentDefinition,
  given: string | undefined,
  kept: string | undefined,
): AgentDefinition {
  const { description: _drop, ...rest } = definition;
  const next = given !== undefined ? given.trim() : kept;
  return next === undefined || next === "" ? rest : { ...rest, description: next };
}

/** A new agent has no id to bind an upload to yet: a client can only choose a preset on create. */
export function assertProfileWritable(profile: ProfileInput | undefined): void {
  if (profile?.avatar?.kind === "upload") {
    throw new ApiError(
      "validation_failed",
      "Choose a preset avatar when creating an agent; upload one afterwards",
      [{ path: "avatar.kind", message: "upload is not supported on create" }],
    );
  }
}

const notFound = () => new ApiError("agent.not_found", "Agent not found");

/** A per-operation policy key of the `Platform` tool (Platform tool spec §6.2). */
const PLATFORM_POLICY_KEY = /^Platform:[a-z][a-z-]*\.[a-z][a-z-]*$/;

/**
 * May `toolPolicies` hold this key: one of the agent's tool keys, or `Platform:<operation>` when
 * `Platform` is among them (an unknown operation id is kept: a removed operation's policy is
 * harmless).
 */
function isToolPolicyKey(key: string, toolKeys: ReadonlySet<string>): boolean {
  return toolKeys.has(key) || (toolKeys.has("Platform") && PLATFORM_POLICY_KEY.test(key));
}

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

/**
 * The pending connectors of a saved definition (ruling P4-6): absent from the request = the current
 * version's (an editor that does not know them never drops them); given = a subset of the current
 * ones, unchanged (only creating from a template adds them, only binding resolves them); `[]`
 * removes them all. Another entry → 400 `validation_failed` at `pendingConnectors.<i>`.
 */
export function keepPendingConnectors(
  definition: AgentDefinition,
  given: readonly PendingConnector[] | undefined,
  current: readonly PendingConnector[] | undefined,
): AgentDefinition {
  const { pendingConnectors: _given, ...rest } = definition;
  const next = given ?? current ?? [];
  if (given !== undefined) {
    const known = new Map((current ?? []).map((c) => [c.key, canonical(c)]));
    const details = given.flatMap((c, i) =>
      known.get(c.key) === canonical(c)
        ? []
        : [
            {
              path: `pendingConnectors.${i}`,
              message: "pending connectors come only from a template; keep or remove them",
            },
          ],
    );
    if (details.length > 0) {
      throw new ApiError("validation_failed", "Invalid pending connectors", details);
    }
  }
  return next.length > 0 ? { ...rest, pendingConnectors: [...next] } : rest;
}

/** `definition` with `disabledTools` in its canonical form (tools default-on spec §2). */
function withCanonicalTools(definition: AgentDefinition): AgentDefinition {
  return { ...definition, disabledTools: canonicalDisabledTools(definition.disabledTools ?? []) };
}

/** Where an agent created from a template came from (ruling P4-8; set once, never versioned). */
export interface TemplateProvenance {
  id: string;
  version: number;
  name: string;
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
 * - `not_found`: a template id that is not a usable agent template of the org (its own, a linked
 *   copy, or a platform template on in the org);
 * - `invalid_name`: an inline name or `agents[].as` outside {@link SUBAGENT_NAME_RE}, or
 *   `general-purpose`; `duplicate`: a roster type listed twice (a template id twice included, a
 *   bare template type equal to an inline name, a template typed `general-purpose`);
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
  const details: { reason: SubagentsProblem; path: string; value?: string; message?: string }[] =
    [];
  const add = (reason: SubagentsProblem, path: string, value?: string, message?: string): void => {
    details.push({
      reason,
      path,
      ...(value !== undefined && { value }),
      ...(message !== undefined && { message }),
    });
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
  // usable templates (the org's, linked copies, platform templates on in the org) by id
  const usable = await loadTemplates(t, a.orgId, ids);
  // kept ids that are no longer usable: their type from the stored row, deleted or off included
  const gone = ids.filter((id) => !usable.has(id) && keptTemplates.has(id));
  const goneTypes = new Map<string, string>();
  if (gone.length > 0) {
    const [orgRows, platformRows] = await Promise.all([
      t
        .selectFrom("agent_templates")
        .select(["id", "name", "plugin_name"])
        .where("org_id", "=", a.orgId)
        .where("id", "in", gone)
        .execute(),
      t
        .selectFrom("platform_agent_templates")
        .select(["id", "name", "plugin_name"])
        .where("id", "in", gone)
        .execute(),
    ]);
    for (const r of [...platformRows, ...orgRows]) {
      goneTypes.set(r.id, templateTypeOf(r.plugin_name, r.name));
    }
  }
  templates.forEach((id, i) => {
    const path = `subagents.templates.${i}`;
    const row = usable.get(id);
    if (!keptTemplates.has(id) && row === undefined) {
      add("not_found", path, id);
      return;
    }
    // claimed by its roster type (`<plugin>:<name>`, or a bare `<name>` without a plugin;
    // roster.ts templateType), so nothing shadows it; `general-purpose` is reserved
    const type =
      row === undefined
        ? (goneTypes.get(id) ?? `template:${id}`)
        : templateTypeOf(row.plugin, row.name);
    if (type === "general-purpose" && sub.general === false) add("duplicate", path, type);
    claim(type, path);
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
      if (a.toolKeys.has(key)) return;
      // an rc key names its current key(s) (tool naming spec §8.3)
      const renamed = legacyKeySaveText(key, a.toolKeys);
      add("tool_not_selected", path, key, renamed ?? undefined);
    };
    for (const [j, key] of (x.tools ?? []).entries()) tool(key, `${base}.tools.${j}`);
    for (const [j, key] of (x.disallowedTools ?? []).entries()) {
      tool(key, `${base}.disallowedTools.${j}`);
    }
    for (const key of Object.keys(x.toolPolicies ?? {})) {
      if (!isToolPolicyKey(key, a.toolKeys)) tool(key, `${base}.toolPolicies.${key}`);
    }
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
      `Invalid sub-agents: ${details
        .map((d) => `${d.path} (${d.reason}${d.message === undefined ? "" : `: ${d.message}`})`)
        .join(", ")}`,
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
    @Inject(ToolRegistry) private readonly tools: Pick<ToolRegistry, "checkDisabled">,
    /** 删除 agent 时取消它待处理的技能改动（T15）。 */
    @Inject(SkillChangesService)
    private readonly skillChanges: Pick<
      SkillChangesService,
      "cancelPendingForAgent" | "finishCancel"
    >,
    /** The org row lock (orgs/org-lock.ts): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize" | "tryLock">,
    /** Resolves the agent's models (and their parameter declarations) when it is saved. */
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** Cancels the deleted agent's running eval runs (in the delete's transaction). */
    @Inject(EvalBudget) private readonly evalBudget: Pick<EvalBudget, "cancelRuns">,
    /** Settles the agent's connector setup request when its pending connectors change (P4-7). */
    @Inject(PendingConnectorRequests)
    private readonly setupRequests: Pick<PendingConnectorRequests, "settleIn" | "retargetIn">,
  ) {}

  /**
   * Checks the turned-off tools and the policies (tools default-on spec §2): `disabledTools` must
   * name existing builtins, extensions and connectors (`ToolRegistry.checkDisabled`); `toolPolicies`
   * keys must be tools the agent could have, on or off (values only tighten, by the schema); a
   * sub-agent's key filter is never saved. Invalid → `validation_failed` at `disabledTools.<i>` /
   * `toolPolicies.<key>` / `subagentTools`. The list is stored in canonical form.
   */
  private async checkTools(
    orgId: string,
    def: AgentDefinitionInput,
    kept: readonly DisabledToolRef[] = [],
  ): Promise<Set<string>> {
    const { keys, issues } = await this.tools.checkDisabled(orgId, def.disabledTools ?? [], kept);
    const details = [...issues];
    if (def.subagentTools !== undefined) {
      details.push({
        path: "subagentTools",
        message: "subagentTools is set only on a sub-agent's definition at dispatch",
      });
    }
    for (const [key, policy] of Object.entries(def.toolPolicies)) {
      // `allow` counts only for a connector tool (decision 2026-11-09): elsewhere a policy only
      // tightens, so an `allow` there is refused rather than kept as a no-op
      if (policy === "allow" && parseToolKey(key)?.kind !== "connector") {
        details.push({
          path: `toolPolicies.${key}`,
          message: `"allow" applies only to a connector's tools; "${key}" can only be tightened (ask or deny)`,
        });
        continue;
      }
      if (!isToolPolicyKey(key, keys)) {
        // an rc key (tool naming spec §8.3): saving writes current keys only, so name them
        const renamed = legacyKeySaveText(key, keys);
        details.push({
          path: `toolPolicies.${key}`,
          message: renamed ?? `"${key}" is not a tool of this agent`,
        });
      }
    }
    if (details.length > 0) {
      throw new ApiError("validation_failed", "Invalid tool references", details);
    }
    return keys;
  }

  /**
   * The current version's `disabledTools` (empty for an agent that is not there: the update's own
   * checks report that): entries kept from it are not re-checked, so a connector deleted or an
   * extension uninstalled later never blocks other edits.
   */
  private async keptDisabled(orgId: string, agentId: string): Promise<DisabledToolRef[]> {
    const row = await this.db.db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select("agent_versions.definition")
      .where("agents.id", "=", agentId)
      .where("agents.org_id", "=", orgId)
      .executeTakeFirst();
    return row === undefined ? [] : (normalizeStoredDefinition(row.definition).disabledTools ?? []);
  }

  /**
   * 校验主模型与兜底都可解析：enabled `chat` models in the org (`resolve`'s default kind; a model the
   * platform or the org disabled, or an embedding model → 400 `agent.model_unavailable`, spec B
   * §5.3），并用各自模型的参数声明严格校验 `modelParams` / `fallbackParams`
   * （没有兜底时 `fallbackParams` 必须为空）；不合法 → `validation_failed`，details 逐键点名。返回提示。
   */
  private async checkModels(orgId: string, def: AgentDefinitionInput): Promise<AgentWarning[]> {
    const registry = this.providers;
    const main = await registry.resolve(orgId, def.model);
    const fallback = def.fallback === null ? null : await registry.resolve(orgId, def.fallback);
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
    request: {
      definition: AgentDefinitionInput;
      visibility: AgentVisibility;
      memberIds?: string[];
      profile?: ProfileInput;
    },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const { agent, warnings } = await this.createChecked(
      orgId,
      actorAccountId,
      request,
      null,
      actorTokenId,
      auditDetail,
    );
    return { agent, warnings };
  }

  /**
   * Creates an agent from a planned template definition (rulings P4-3, P4-8): {@link create}'s
   * checks, plus, under the org row lock, 403 `agent.visibility_forbidden` when the visibility is
   * not `private` and the creator lacks `agents.manage`; the provenance columns are written once.
   * Returns the creator's role read under the lock (the caller decides on the pending connector
   * request after the commit).
   */
  createFromTemplate(
    orgId: string,
    actorAccountId: string,
    request: {
      definition: AgentDefinitionInput;
      visibility: AgentVisibility;
      memberIds?: string[];
      profile?: ProfileInput;
    },
    template: TemplateProvenance,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[]; role: OrgRole }> {
    return this.createChecked(orgId, actorAccountId, request, template, actorTokenId, auditDetail);
  }

  private async createChecked(
    orgId: string,
    actorAccountId: string,
    request: {
      definition: AgentDefinitionInput;
      visibility: AgentVisibility;
      memberIds?: string[];
      profile?: ProfileInput;
    },
    template: TemplateProvenance | null,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[]; role: OrgRole }> {
    const input = {
      ...request,
      // run context spec §3.5: version 1 carries the description (the profile's when the
      // definition gives none)
      definition: withCanonicalTools(
        withDescription(
          deriveInstructions(request.definition, null),
          request.definition.description ?? request.profile?.description,
          undefined,
        ),
      ),
    };
    // 先解析模型（可能访问供应商），不在持有组织行锁时做
    const warnings = await this.checkModels(orgId, input.definition);
    const toolKeys = await this.checkTools(orgId, input.definition);
    if (input.visibility !== "members" && (input.memberIds?.length ?? 0) > 0) {
      throw new ApiError("validation_failed", "memberIds requires visibility 'members'");
    }
    assertProfileWritable(input.profile);
    const { agent, role } = await this.createIn(
      orgId,
      actorAccountId,
      input,
      toolKeys,
      template,
      actorTokenId,
      auditDetail,
    );
    return { agent, warnings, role };
  }

  @Transactional()
  private async createIn(
    orgId: string,
    actorAccountId: string,
    input: {
      definition: AgentDefinition;
      visibility: AgentVisibility;
      memberIds?: string[];
      profile?: ProfileInput;
    },
    toolKeys: Set<string>,
    template: TemplateProvenance | null,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<{ agent: AgentView; role: OrgRole }> {
    const t = this.db.db;
    const { role } = await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "agents.create");
    // ruling P4-3: a member creates a template agent for themself; sharing it is an admin's call
    if (template !== null && input.visibility !== "private" && !can(role, "agents.manage")) {
      throw new ApiError(
        "agent.visibility_forbidden",
        "Only an organization admin can create an agent from a template for others; create it private",
      );
    }
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
        profile_avatar: JSON.stringify(
          input.profile?.avatar ?? { kind: "preset", id: randomPreset() },
        ),
        profile_description: input.definition.description ?? "",
        profile_quick_actions: JSON.stringify(input.profile?.quickActions ?? []),
        ...(template !== null && {
          created_from_template_id: template.id,
          created_from_template_version: template.version,
          created_from_template_name: template.name,
        }),
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
      detail: {
        version: 1,
        visibility: input.visibility,
        ...(template !== null && { template: { id: template.id, version: template.version } }),
        ...auditDetail,
      },
    });
    return { agent: await this.lookup.view(id), role };
  }

  /**
   * 锁组织行并复核发起人，再锁 agent 行：发起人须仍具备 `agents.create`（member 以上），且是负责人或组织管理员以上；
   * 对发起人不可见的 agent（非管理员）→ `agent.not_found`，可见但无权 → `forbidden`。
   */
  @Transactional({ propagation: "mandatory" })
  async lockForWrite(
    orgId: string,
    agentId: string,
    actorAccountId: string,
  ): Promise<{ visibility: AgentVisibility; current_version: number }> {
    const t = this.db.db;
    const { role } = await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "agents.create");
    const agent = await this.lockAgentRow(orgId, agentId);
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
   * Locks the live agent row of `orgId` (the caller holds the org row lock); missing or deleted →
   * `agent.not_found`.
   */
  @Transactional({ propagation: "mandatory" })
  private async lockAgentRow(
    orgId: string,
    agentId: string,
  ): Promise<{
    owner_account_id: string;
    needs_reassignment: boolean;
    visibility: AgentVisibility;
    current_version: number;
  }> {
    // NO KEY UPDATE: a soft delete then appends revert snapshots to conversations; FOR UPDATE would
    // block the agent foreign key check of an append already holding one of them (40P01)
    const agent = await this.db.db
      .selectFrom("agents")
      .select(["owner_account_id", "needs_reassignment", "visibility", "current_version"])
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!agent) throw notFound();
    return agent;
  }

  /**
   * The platform path's lock (a super admin who need not be a member of the org): finds the live
   * agent's org, locks the org row, then the agent row. A missing or deleted agent, or one of a
   * deleted org → `agent.not_found`. The super admin check is the caller's (`@SuperAdmin()`).
   */
  @Transactional({ propagation: "mandatory" })
  private async lockForPlatform(agentId: string): Promise<{
    orgId: string;
    agent: { owner_account_id: string; needs_reassignment: boolean };
  }> {
    const found = await this.db.db
      .selectFrom("agents")
      .select("org_id")
      .where("id", "=", agentId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!found) throw notFound();
    const orgId = found.org_id;
    if (!(await this.orgLock.tryLock(orgId))) throw notFound();
    return { orgId, agent: await this.lockAgentRow(orgId, agentId) };
  }

  /**
   * 修改 agent：`definition` 变化时写新版本（`current_version + 1`），只改 visibility / memberIds 不产生新版本。
   * 只有负责人或组织管理员以上可改，在组织行锁内复核。
   */
  async update(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    request: {
      definition?: AgentDefinitionInput | undefined;
      visibility?: AgentVisibility | undefined;
      memberIds?: string[] | undefined;
      /**
       * 给出且不等于当前版本 → `agent.version_conflict`（409），在锁内判定。只比定义版本：只改可见范围 / 成员
       * 不产生新版本，所以检测不到别人只改了可见范围（之后的保存会按本次给出的 visibility 覆盖）。
       */
      expectedVersion?: number | undefined;
    },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const patch = request;
    const warnings = patch.definition ? await this.checkModels(orgId, patch.definition) : [];
    const toolKeys = patch.definition
      ? await this.checkTools(orgId, patch.definition, await this.keptDisabled(orgId, agentId))
      : null;
    const agent = await this.updateIn(
      orgId,
      agentId,
      actorAccountId,
      patch,
      toolKeys,
      actorTokenId,
      auditDetail,
    );
    return { agent, warnings };
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    patch: {
      definition?: AgentDefinitionInput | undefined;
      visibility?: AgentVisibility | undefined;
      memberIds?: string[] | undefined;
      expectedVersion?: number | undefined;
    },
    toolKeys: Set<string> | null,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
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
      // the prompt: instructionFiles give instructions; a save given neither keeps the current one
      const currentDefinition = normalizeStoredDefinition(current.definition);
      const definition = withCanonicalTools(
        withDescription(
          keepPendingConnectors(
            deriveInstructions(patch.definition, currentDefinition),
            patch.definition.pendingConnectors,
            currentDefinition.pendingConnectors,
          ),
          patch.definition.description,
          currentDefinition.description,
        ),
      );
      // the display copy follows every description the save gives (run context spec §3.5)
      if (patch.definition.description !== undefined) {
        await t
          .updateTable("agents")
          .set({ profile_description: definition.description ?? "" })
          .where("id", "=", agentId)
          .execute();
      }
      // 当前版本已有的技能引用保存时合法，不再核对（被删的技能不挡住其他改动）；新加的照常核对
      const kept = new Set((current.definition as AgentDefinition).skills?.orgSkills ?? []);
      await assertOrgSkills(t, orgId, definition.skills?.orgSkills ?? [], kept);
      await assertPinnedSkills(
        t,
        orgId,
        agentId,
        definition.skills,
        (current.definition as AgentDefinition).skills?.pinned ?? [],
      );
      await assertSubagents(t, {
        orgId,
        agentId,
        actorAccountId,
        definition,
        toolKeys: toolKeys ?? new Set(),
        kept: (current.definition as AgentDefinition).subagents,
      });
      if (canonical(current.definition) !== canonical(definition)) {
        // removing pending connectors in the editor narrows or cancels the setup request (P4-T6-3)
        const keys = (definition.pendingConnectors ?? []).map((c) => c.key);
        if (
          canonical((currentDefinition.pendingConnectors ?? []).map((c) => c.key)) !==
          canonical(keys)
        ) {
          await this.setupRequests.settleIn({
            orgId,
            agentId,
            keys,
            close: "cancelled",
            actor: actorAccountId,
            actorTokenId,
          });
        }
        toVersion = before.current_version + 1;
        await t
          .insertInto("agent_versions")
          .values({
            agent_id: agentId,
            version: toVersion,
            definition: JSON.stringify(definition),
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
        ...auditDetail,
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
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const cancelled = await this.softDeleteIn(
      orgId,
      agentId,
      actorAccountId,
      actorTokenId,
      auditDetail,
    );
    await this.skillChanges.finishCancel(orgId, cancelled);
  }

  @Transactional()
  private async softDeleteIn(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    actorTokenId: string | undefined,
    auditDetail?: Record<string, unknown>,
  ) {
    await this.lockForWrite(orgId, agentId, actorAccountId);
    return this.softDeleteLocked(
      orgId,
      agentId,
      { accountId: actorAccountId, ...(actorTokenId !== undefined && { tokenId: actorTokenId }) },
      auditDetail,
    );
  }

  /**
   * The platform's delete (a super admin who need not be a member of the agent's org): the same
   * effects as {@link softDelete}, under the org row lock, audited `agent.deleted` with
   * `detail.via = "platform"`. A missing or deleted agent, or one of a deleted org →
   * `agent.not_found`. `auditDetail` (a Platform tool write's `viaAgent`) is merged into the
   * detail; `via` stays `"platform"`.
   */
  async softDeleteAsPlatform(
    agentId: string,
    actor: WriteActor,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const { orgId, cancelled } = await this.softDeleteAsPlatformIn(agentId, actor, auditDetail);
    await this.skillChanges.finishCancel(orgId, cancelled);
  }

  @Transactional()
  private async softDeleteAsPlatformIn(
    agentId: string,
    actor: WriteActor,
    auditDetail: Record<string, unknown> | undefined,
  ) {
    const { orgId } = await this.lockForPlatform(agentId);
    const cancelled = await this.softDeleteLocked(orgId, agentId, actor, {
      ...auditDetail,
      via: "platform",
    });
    return { orgId, cancelled };
  }

  /** The delete itself; the caller holds the org row and agent row locks. */
  @Transactional({ propagation: "mandatory" })
  private async softDeleteLocked(
    orgId: string,
    agentId: string,
    actor: WriteActor,
    auditDetail: Record<string, unknown> | undefined,
  ) {
    const t = this.db.db;
    const { accountId: actorAccountId, tokenId: actorTokenId } = actor;
    await t
      .updateTable("agents")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", agentId)
      .execute();
    // the avatar upload is garbage now: the cleanup job deletes it (and its object) once expired
    await t
      .updateTable("attachments")
      .set({ expires_at: sql<Date>`now()` })
      .where("agent_id", "=", agentId)
      .where("purpose", "=", "agent-avatar")
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.deleted",
      target: agentId,
      ...(auditDetail !== undefined && { detail: auditDetail }),
    });
    // the agent row stays (soft delete), so its setup request is closed here (P4-T6-3)
    await this.setupRequests.settleIn({
      orgId,
      agentId,
      keys: [],
      close: "cancelled",
      actor: actorAccountId,
      actorTokenId,
    });
    // 评测集的 agent 删除后其评测运行不再花钱：显式取消（审计带原因）
    await this.evalBudget.cancelRuns(
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
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "agents.manage");
    const agent = await this.lockAgentRow(orgId, agentId);
    return this.reassignOwnerLocked(
      orgId,
      agentId,
      agent,
      newOwnerId,
      { accountId: actorAccountId, ...(actorTokenId !== undefined && { tokenId: actorTokenId }) },
      undefined,
    );
  }

  /**
   * The platform's owner transfer (a super admin who need not be a member of the agent's org):
   * the same checks and effects as {@link reassignOwner} (the new owner is a member of the agent's
   * org and not its anonymous guest), audited with `detail.via = "platform"`. A missing or deleted
   * agent, or one of a deleted org → `agent.not_found`.
   */
  @Transactional()
  async reassignOwnerAsPlatform(
    agentId: string,
    newOwnerId: string,
    actor: WriteActor,
  ): Promise<AgentView> {
    const { orgId, agent } = await this.lockForPlatform(agentId);
    return this.reassignOwnerLocked(orgId, agentId, agent, newOwnerId, actor, { via: "platform" });
  }

  /** The owner transfer itself; the caller holds the org row and agent row locks. */
  @Transactional({ propagation: "mandatory" })
  private async reassignOwnerLocked(
    orgId: string,
    agentId: string,
    agent: { owner_account_id: string; needs_reassignment: boolean },
    newOwnerId: string,
    actor: WriteActor,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<AgentView> {
    const t = this.db.db;
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
    // the new owner hears about the agent's connector setup request (P4-T6-4)
    await this.setupRequests.retargetIn([agentId], newOwnerId);
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "agent.owner_changed",
      target: agentId,
      detail: {
        from: agent.owner_account_id,
        to: newOwnerId,
        neededReassignment: agent.needs_reassignment,
        ...auditDetail,
      },
    });
    return this.lookup.view(agentId);
  }

  /**
   * `views` with `createdFrom.available` set (ruling P4-8): whether each recorded template is
   * still usable in the org. One template read for all of them; only the agents API calls it.
   */
  async withTemplateLinks<T extends AgentView>(orgId: string, views: T[]): Promise<T[]> {
    const ids = [
      ...new Set(views.flatMap((v) => (v.createdFrom === null ? [] : [v.createdFrom.templateId]))),
    ];
    if (ids.length === 0) return views;
    const usable = await loadTemplates(this.db.db, orgId, ids);
    return views.map((v) =>
      v.createdFrom === null
        ? v
        : {
            ...v,
            createdFrom: { ...v.createdFrom, available: usable.has(v.createdFrom.templateId) },
          },
    );
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
