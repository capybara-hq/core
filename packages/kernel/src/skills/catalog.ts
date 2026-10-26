import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import type { EventLog } from "../conversations/event-log.js";
import { type ConversationEvent, SKILLS_CATALOG_MAX } from "../conversations/events.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { type CatalogSkill, sameSkills } from "../runtime/context/skills.js";

/**
 * 技能目录快照（M5 T14，Ruling M17）：运行开始时解析「此刻对这个对话生效的技能」，与日志里最新一份快照不同才写
 * `skills_catalog`。模型看到的目录与 `skill_load` 的名字解析只来自日志，不读实时的库。
 */

/**
 * Pinned skill limits (spec §9.1): at most `count` pinned skills per agent, whose current SKILL.md
 * sizes total at most `totalBytes`. Saving checks both; at run time the pinned bodies are kept in
 * the agent's order while they fit.
 */
export const PINNED_SKILLS_LIMITS = { count: 3, totalBytes: 32768 } as const;

/** {@link resolveEffectiveSkills} 的输入。 */
export interface EffectiveSkillsInput {
  orgId: string;
  agentId: string;
  /** 本次运行固定的 agent 版本的定义（`skills.orgSkills` 是选中的组织技能 id）。 */
  agent: Pick<AgentDefinition, "skills">;
  /**
   * 对话 id：共享 agent 待批准的技能改动（T15，`skill_change_requests`）只在发起它的对话里生效（试用），
   * 在这里按对话覆盖。
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
 * 试用（T15，R4）：这个 agent 待批准、且由本对话发起的技能改动，按名字替换对应技能的版本 / 新增技能
 * （id 为已有技能或预先分配的 id，版本为批准后预期的版本号）；其他对话照旧用 `current_version`。
 * 批准后版本成为当前版本，各对话下一次运行开始时由快照差异得到提醒；拒绝 / 取消后发起对话回到当前版本。
 */
export async function resolveEffectiveSkills(
  db: KernelDb,
  input: EffectiveSkillsInput,
  log?: Pick<Logger, "warn">,
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
      "skill_versions.object_prefix",
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
  const effective = new Map<string, CatalogSkill>(
    [...byName.values()].map((r) => [
      r.name,
      {
        id: r.id,
        name: r.name,
        description: r.manifest.description,
        version: r.current_version,
        source: r.object_prefix,
      },
    ]),
  );
  const trials = await db
    .selectFrom("skill_change_requests")
    .select(["proposed_version", "object_prefix"])
    .where("requested_in_conversation", "=", input.conversationId)
    .where("agent_id", "=", input.agentId)
    .where("org_id", "=", input.orgId)
    .where("status", "=", "pending")
    .execute();
  for (const { proposed_version: p, object_prefix } of trials) {
    effective.set(p.manifest.name, {
      id: p.skillId,
      name: p.manifest.name,
      description: p.manifest.description,
      version: p.version,
      source: object_prefix,
    });
  }
  const all = [...effective.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  // 快照大小不能让运行失败：按名字排序后确定地截到上限（事件 schema 的上限）
  if (all.length > SKILLS_CATALOG_MAX) {
    log?.warn("skills catalog truncated", {
      orgId: input.orgId,
      agentId: input.agentId,
      skills: all.length,
      kept: SKILLS_CATALOG_MAX,
    });
    return all.slice(0, SKILLS_CATALOG_MAX);
  }
  return all;
}

/** `skills_catalog` 的幂等键：每次运行最多写一份。 */
/**
 * 是否给模型 `skill_load`：日志里有过技能目录快照（Ruling M17），**即使最新一份是空的**。构建请求与执行工具调用
 * 用同一判定。不因空快照收回这个工具：工具集合一变缓存前缀就失效；而且 agent 没有别的工具时会发出「没有工具
 * 但历史里有 tool_use」的请求，Anthropic 会拒绝。空目录下调用 skill_load 由 `NO_SKILLS_TEXT` 给出可执行的说明。
 */
export function skillLoadOffered(
  latest: Extract<ConversationEvent, { type: "skills_catalog" }> | undefined,
): boolean {
  return latest !== undefined;
}

export const skillsCatalogIdemKey = (runId: string): string => `skills_catalog:${runId}`;

/**
 * 在事务 `t` 里锁会话行（与 `EventLog.append` 同一把锁）并读最新一份技能目录快照（没有为 undefined）。
 * 「读最新 → 推出下一份 → 追加」都在这把锁内，别的写快照的事务（运行开始、skill_write、拒绝时的回退）插不进来。
 */
export async function lockLatestCatalog(
  t: Transaction<KernelDatabase>,
  conversationId: string,
): Promise<CatalogSkill[] | undefined> {
  await t
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .forUpdate()
    .executeTakeFirst();
  const last = await t
    .selectFrom("conversation_events")
    .select("payload")
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "skills_catalog")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  return last ? (last.payload as { skills: CatalogSkill[] }).skills : undefined;
}

/**
 * 运行开始时记录技能目录快照：解析生效的技能，与日志里最新一份不同才写（带幂等键，崩溃重试不重复）。
 * 从没有快照、现在也没有技能 → 不写（没有技能的 agent 不出现目录）；之前有、现在全没了 → 写空快照（模型据此得知被移除）。
 * 解析、比较、追加在一个事务里、先锁会话行：否则在解析与追加之间提交的拒绝 + 回退快照会被过时的草稿条目盖回去。
 * 解析只读 skills / agents / 申请（不加锁），不会与别的路径形成死锁。
 */
export async function recordSkillsCatalog(
  deps: {
    db: KernelDb;
    eventLog: Pick<EventLog, "append" | "notify">;
    log?: Pick<Logger, "warn">;
  },
  input: EffectiveSkillsInput & { runId: string },
): Promise<void> {
  const toSeq = await deps.db.transaction().execute(async (t) => {
    const last = await lockLatestCatalog(t, input.conversationId);
    const skills = await resolveEffectiveSkills(t, input, deps.log);
    if (last ? sameSkills(last, skills) : skills.length === 0) return null;
    const written = await deps.eventLog.append(
      input.conversationId,
      [
        {
          type: "skills_catalog",
          runId: input.runId,
          idemKey: skillsCatalogIdemKey(input.runId),
          payload: { skills },
        },
      ],
      t,
    );
    return Math.max(...written.map((e) => e.seq));
  });
  if (toSeq !== null) await deps.eventLog.notify(input.conversationId, toSeq);
}
