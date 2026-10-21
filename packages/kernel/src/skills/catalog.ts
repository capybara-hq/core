import type { AgentDefinition } from "../agents/definition.js";
import type { EventLog } from "../conversations/event-log.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { type CatalogSkill, sameSkills } from "../runtime/context/skills.js";

/**
 * 技能目录快照（M5 T14，Ruling M17）：运行开始时解析「此刻对这个对话生效的技能」，与日志里最新一份快照不同才写
 * `skills_catalog`。模型看到的目录与 `skill_load` 的名字解析只来自日志，不读实时的库。
 */

/** {@link resolveEffectiveSkills} 的输入。 */
export interface EffectiveSkillsInput {
  orgId: string;
  agentId: string;
  /** 本次运行固定的 agent 版本的定义（`skills.orgSkills` 是选中的组织技能 id）。 */
  agent: Pick<AgentDefinition, "skills">;
  /**
   * 对话 id：T15 的「试用中的改动」只在发起它的对话里生效（待批准的技能改动在这里按对话覆盖），
   * 本任务尚未使用。
   */
  conversationId: string;
}

/**
 * 此刻对这个对话生效的技能，按名字（码点序）排序：
 * - 运行所用 agent 版本选中的组织技能（`scope='org'`，id 在 `skills.orgSkills` 里）；
 * - 加上这个 agent 自己的技能（`scope='agent'`）；
 * - 已删除的跳过（保存过的 agent 版本仍可能引用它们）；
 * - 版本取 `current_version`，描述取该版本清单里的描述。
 * 组织技能与 agent 自己的技能同名时只保留 agent 自己的（更具体；`/skills/<name>/` 与按名字加载都不能有两个）。
 *
 * T15 的接缝：待批准的技能改动（试用）只在发起它的对话里替换对应技能的版本 / 新增技能，在这里按
 * `input.conversationId` 合并进结果。
 */
export async function resolveEffectiveSkills(
  db: KernelDb,
  input: EffectiveSkillsInput,
): Promise<CatalogSkill[]> {
  const orgSkills = [...new Set(input.agent.skills?.orgSkills ?? [])];
  const rows = await db
    .selectFrom("skills")
    .innerJoin("skill_versions", (j) =>
      j
        .onRef("skill_versions.skill_id", "=", "skills.id")
        .onRef("skill_versions.version", "=", "skills.current_version"),
    )
    .select([
      "skills.id",
      "skills.scope",
      "skills.name",
      "skills.current_version",
      "skill_versions.manifest",
    ])
    .where("skills.org_id", "=", input.orgId)
    .where("skills.deleted_at", "is", null)
    .where((eb) => {
      const agentOwn = eb.and([
        eb("skills.scope", "=", "agent"),
        eb("skills.agent_id", "=", input.agentId),
      ]);
      if (orgSkills.length === 0) return agentOwn;
      return eb.or([
        agentOwn,
        eb.and([eb("skills.scope", "=", "org"), eb("skills.id", "in", orgSkills)]),
      ]);
    })
    .execute();
  const byName = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byName.get(r.name);
    if (!prev || (prev.scope === "org" && r.scope === "agent")) byName.set(r.name, r);
  }
  return [...byName.values()]
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.manifest.description,
      version: r.current_version,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `skills_catalog` 的幂等键：每次运行最多写一份。 */
export const skillsCatalogIdemKey = (runId: string): string => `skills_catalog:${runId}`;

/**
 * 运行开始时记录技能目录快照：解析生效的技能，与日志里最新一份不同才写（带幂等键，崩溃重试不重复）。
 * 从没有快照、现在也没有技能 → 不写（没有技能的 agent 不出现目录）；之前有、现在全没了 → 写空快照（模型据此得知被移除）。
 */
export async function recordSkillsCatalog(
  deps: { db: KernelDb; eventLog: Pick<EventLog, "append" | "latestOfType"> },
  input: EffectiveSkillsInput & { runId: string },
): Promise<void> {
  const skills = await resolveEffectiveSkills(deps.db, input);
  const last = await deps.eventLog.latestOfType(input.conversationId, "skills_catalog");
  if (last ? sameSkills(last.payload.skills, skills) : skills.length === 0) return;
  await deps.eventLog.append(input.conversationId, [
    {
      type: "skills_catalog",
      runId: input.runId,
      idemKey: skillsCatalogIdemKey(input.runId),
      payload: { skills },
    },
  ]);
}
