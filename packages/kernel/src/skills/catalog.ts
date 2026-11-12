import type { Logger, SkillInvocation } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import { EventLog } from "../conversations/event-log.js";
import { type ConversationEvent, SKILLS_CATALOG_MAX } from "../conversations/events.js";
import type { KernelSchemaDb, SkillManifest, SourceFormat } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CLAUDE_CODE_TOOL_MAP } from "../runtime/context/claude-tools.js";
import { type CatalogSkill, type SkillsSnapshot, sameSnapshot } from "../runtime/context/skills.js";
import { agentSkills, type SkillVersionRow } from "./usable.js";

/**
 * 技能目录快照（M5 T14，Ruling M17）：运行开始时解析「此刻对这个对话生效的技能」，与日志里最新一份快照不同才写
 * `skills_catalog`。模型看到的目录与 `Skill` 的名字解析只来自日志，不读实时的库。
 */

/** {@link resolveEffectiveSkills} 的输入。 */
export interface EffectiveSkillsInput {
  orgId: string;
  agentId: string;
  /** The definition of the run's agent version (`disabledSkills`: what it turns off). */
  agent: Pick<AgentDefinition, "disabledSkills">;
  /**
   * The conversation id: a pending skill change of the agent (`skill_change_requests`, a version
   * draft) applies only in the conversation that proposed it (a trial) and is overlaid here.
   */
  conversationId: string;
}

/**
 * The skills in effect for this conversation now, sorted by name (code point order), as
 * {@link agentSkills} resolves them (skills default-on spec §3):
 * - the agent's own skills (`scope='agent'`) and the org skills it shared;
 * - plus every skill on in the org, minus what the run's agent version's `disabledSkills` turns
 *   off (never a builtin plugin's skill);
 * - deleted skills are skipped;
 * - the version is `current_version`, the description the one in that version's manifest.
 * When an org skill and the agent's own skill share a name only the agent's own is kept (more
 * specific; neither `/skills/<name>/` nor loading by name can have two).
 *
 * Trials: a pending version proposal of this agent made in this conversation replaces, by name,
 * the version of its skill (the id of the existing skill, the version it would become on
 * approval); other conversations keep `current_version`. Once approved it is the current version
 * and every conversation gets a notice from the snapshot difference at its next run start; after
 * a reject or cancel the proposing conversation goes back to the current version.
 */
export async function resolveEffectiveSkills(
  db: KernelSchemaDb,
  input: EffectiveSkillsInput,
  log?: Pick<Logger, "warn">,
): Promise<CatalogSkill[]> {
  return forModel(await resolveSkills(db, input), input, log).map((r) => r.skill);
}

/** The invocation metadata of a skill version: the manifest's, or the defaults when absent. */
export function invocationOf(manifest: Pick<SkillManifest, "invocation">): SkillInvocation {
  return manifest.invocation ?? { model: true, user: true };
}

/**
 * The skills the model sees (phase D): the effective skills without manual-only versions
 * (`invocation.model === false`), cut deterministically to the snapshot's size limit.
 */
function forModel(
  all: readonly ResolvedSkill[],
  input: Pick<EffectiveSkillsInput, "orgId" | "agentId">,
  log?: Pick<Logger, "warn">,
): ResolvedSkill[] {
  const model = all.filter((r) => invocationOf(r.manifest).model);
  // 快照大小不能让运行失败：按名字排序后确定地截到上限（事件 schema 的上限）
  if (model.length > SKILLS_CATALOG_MAX) {
    log?.warn("skills catalog truncated", {
      orgId: input.orgId,
      agentId: input.agentId,
      skills: model.length,
      kept: SKILLS_CATALOG_MAX,
    });
    return model.slice(0, SKILLS_CATALOG_MAX);
  }
  return model;
}

/** An effective skill with what the snapshot needs beyond its catalog entry. */
export interface ResolvedSkill {
  skill: CatalogSkill;
  /** The source format of its version (a trial draft is `capybara`). */
  format: SourceFormat;
  /** Its version's file manifest (a trial draft's proposed one). */
  manifest: SkillManifest;
}

/**
 * Every effective skill with its format and manifest, sorted by name, manual-only versions
 * included and not truncated ({@link forModel} gives the model's part). Without
 * `conversationId` (a conversation not created yet) no trial draft applies.
 */
export async function resolveSkills(
  db: KernelSchemaDb,
  input: Omit<EffectiveSkillsInput, "conversationId"> & { conversationId?: string },
  log?: Pick<Logger, "warn">,
): Promise<ResolvedSkill[]> {
  const rows = await agentSkills(
    db,
    {
      orgId: input.orgId,
      agentId: input.agentId,
      disabledSkills: input.agent.disabledSkills ?? [],
    },
    log,
  );
  // One skill per name: the agent's own, then an org skill or copy, then a platform skill; ties by
  // id
  const rank = (r: SkillVersionRow) =>
    r.scope === "agent" ? 0 : r.platformSkillId === r.id ? 2 : 1;
  const byName = new Map<string, SkillVersionRow>();
  for (const r of rows) {
    const prev = byName.get(r.name);
    if (!prev || rank(r) < rank(prev)) byName.set(r.name, r);
  }
  const effective = new Map<string, ResolvedSkill>(
    [...byName.values()].map((r) => [
      r.name,
      {
        skill: {
          id: r.id,
          name: r.name,
          description: r.description,
          version: r.version,
          source: r.source,
          ...(r.plugin !== null && { plugin: r.plugin }),
        },
        format: r.format,
        manifest: r.manifest,
      },
    ]),
  );
  const trials =
    input.conversationId === undefined
      ? []
      : await db
          .selectFrom("skill_change_requests")
          .select(["proposed_version", "object_prefix"])
          .where("requested_in_conversation", "=", input.conversationId)
          .where("agent_id", "=", input.agentId)
          .where("org_id", "=", input.orgId)
          .where("status", "=", "pending")
          // a share request carries no new files: never a trial
          .where("kind", "=", "version")
          .execute();
  for (const { proposed_version: p, object_prefix } of trials) {
    effective.set(p.manifest.name, {
      skill: {
        id: p.skillId,
        name: p.manifest.name,
        description: p.manifest.description,
        version: p.version,
        source: object_prefix,
      },
      format: "capybara",
      manifest: p.manifest,
    });
  }
  return [...effective.values()].sort((a, b) =>
    a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0,
  );
}

/** `skills_catalog` 的幂等键：每次运行最多写一份。 */
/**
 * 是否给模型 `Skill`：日志里有过技能目录快照（Ruling M17），**即使最新一份是空的**。构建请求与执行工具调用
 * 用同一判定。不因空快照收回这个工具：工具集合一变缓存前缀就失效；而且 agent 没有别的工具时会发出「没有工具
 * 但历史里有 tool_use」的请求，Anthropic 会拒绝。空目录下调用 Skill 由 `NO_SKILLS_TEXT` 给出可执行的说明。
 */
export function skillLoadOffered(
  latest: Extract<ConversationEvent, { type: "skills_catalog" }> | undefined,
  /**
   * Phase D (batch 2 review I2): the log holds a person's skill invocation (any `user_message`
   * with `skill`), so an agent whose skills are all manual-only can still copy an invoked skill's
   * files. Derived from the log, so a replay recomputes it.
   */
  invoked = false,
): boolean {
  return latest !== undefined || invoked;
}

/** Whether `events` hold a person's skill invocation (a `user_message` with `skill`). */
export const hasInvocation = (events: readonly ConversationEvent[]): boolean =>
  events.some((e) => e.type === "user_message" && e.payload.skill !== undefined);

/** {@link skillLoadOffered} for a conversation, read from the database. */
export async function skillLoadOfferedIn(
  db: KernelSchemaDb,
  eventLog: Pick<EventLog, "latestOfType">,
  conversationId: string,
): Promise<boolean> {
  if (await eventLog.latestOfType(conversationId, "skills_catalog")) return true;
  const row = await db
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "user_message")
    .where(sql<boolean>`payload -> 'skill' IS NOT NULL`)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export const skillsCatalogIdemKey = (runId: string): string => `skills_catalog:${runId}`;

/**
 * 在调用方事务里锁会话行（与 `EventLog.append` 同一把锁）并读最新一份技能目录快照（没有为 undefined）。
 * `db` is the caller's transaction handle (`KernelDb.db` inside `@Transactional`).
 * 「读最新 → 推出下一份 → 追加」都在这把锁内，别的写快照的事务（运行开始、技能注册、拒绝时的回退）插不进来。
 */
export async function lockLatestCatalog(
  db: KernelSchemaDb,
  conversationId: string,
): Promise<SkillsSnapshot | undefined> {
  await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .forUpdate()
    .executeTakeFirst();
  const last = await db
    .selectFrom("conversation_events")
    .select("payload")
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "skills_catalog")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  return last ? (last.payload as SkillsSnapshot) : undefined;
}

/**
 * 运行开始时记录技能目录快照：解析生效的技能，与日志里最新一份不同才写（带幂等键，崩溃重试不重复）。
 * 从没有快照、现在也没有技能 → 不写（没有技能的 agent 不出现目录）；之前有、现在全没了 → 写空快照（模型据此得知被移除）。
 * 解析、比较、追加在一个事务里、先锁会话行：否则在解析与追加之间提交的拒绝 + 回退快照会被过时的草稿条目盖回去。
 * 解析只读 skills / agents / 申请（不加锁），不会与别的路径形成死锁。
 *
 * The snapshot also carries each skill's `plugin` and the Claude Code tool-name map (`toolMap`,
 * iff an effective skill has source format `claude-code`). It never carries `pinned` any more
 * (skills default-on spec §8): a conversation whose latest snapshot has pins gets one without them,
 * and the request tells the model they were removed. Run start reads no object storage.
 */
@Injectable()
export class SkillsCatalogService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Records the run start's snapshot (see the class comment). `opts.log`: the run's logger
   * (default the kernel logger).
   */
  async record(
    input: EffectiveSkillsInput & { runId: string },
    opts: { log?: Pick<Logger, "warn" | "error"> } = {},
  ): Promise<void> {
    const toSeq = await this.append(input, opts.log ?? this.log);
    if (toSeq !== null) await this.eventLog.notify(input.conversationId, toSeq);
  }

  /** Under the conversation row lock, resolves the skills and appends a changed snapshot. */
  @Transactional()
  private async append(
    input: EffectiveSkillsInput & { runId: string },
    log: Pick<Logger, "warn" | "error">,
  ): Promise<number | null> {
    const last = await lockLatestCatalog(this.db.db, input.conversationId);
    const all = await resolveSkills(this.db.db, input, log);
    const resolved = forModel(all, input, log);
    const skills = resolved.map((r) => r.skill);
    const next: SkillsSnapshot = {
      skills,
      // The model's (truncated) skills as before phase D, plus manual-only ones: a person can
      // invoke one whose body names Claude tools (batch 1 review M8)
      ...([...resolved, ...all.filter((r) => !invocationOf(r.manifest).model)].some(
        (r) => r.format === "claude-code",
      ) && {
        toolMap: CLAUDE_CODE_TOOL_MAP,
      }),
    };
    if (last ? sameSnapshot(last, next) : skills.length === 0) return null;
    const written = await this.eventLog.appendIn(input.conversationId, [
      {
        type: "skills_catalog",
        runId: input.runId,
        idemKey: skillsCatalogIdemKey(input.runId),
        payload: next,
      },
    ]);
    return Math.max(...written.map((e) => e.seq));
  }
}
