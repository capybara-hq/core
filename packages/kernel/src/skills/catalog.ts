import { createHash } from "node:crypto";
import {
  type Logger,
  parseSkillMd,
  SKILL_ENTRY_FILE,
  type SkillInvocation,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import type { EventLog } from "../conversations/event-log.js";
import { type ConversationEvent, SKILLS_CATALOG_MAX } from "../conversations/events.js";
import type { KernelDatabase, KernelDb, SkillManifest, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { CLAUDE_CODE_TOOL_MAP } from "../runtime/context/claude-tools.js";
import {
  type CatalogSkill,
  type PinnedSkill,
  type SkillsSnapshot,
  sameSnapshot,
} from "../runtime/context/skills.js";
import type { StorageService } from "../storage/storage.service.js";

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
  db: KernelDb,
  input: Omit<EffectiveSkillsInput, "conversationId"> & { conversationId?: string },
): Promise<ResolvedSkill[]> {
  const orgSkills = [...new Set(input.agent.skills?.orgSkills ?? [])];
  const rows = await db
    .selectFrom("skills")
    .innerJoin("skill_versions", (j) =>
      j
        .onRef("skill_versions.skill_id", "=", "skills.id")
        .onRef("skill_versions.version", "=", "skills.current_version"),
    )
    .leftJoin("catalog_items", "catalog_items.id", "skills.catalog_item_id")
    .select([
      "skills.id",
      "skills.scope",
      "skills.name",
      "skills.current_version",
      "skill_versions.manifest",
      "skill_versions.object_prefix",
      "skill_versions.source_format",
      "catalog_items.name as item_name",
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
  const effective = new Map<string, ResolvedSkill>(
    [...byName.values()].map((r) => [
      r.name,
      {
        skill: {
          id: r.id,
          name: r.name,
          description: r.manifest.description,
          version: r.current_version,
          source: r.object_prefix,
          ...(r.item_name !== null && { plugin: r.item_name }),
        },
        format: r.source_format,
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

/** A pinned skill to read: an effective skill the agent version pins. */
interface PinnedCandidate {
  id: string;
  version: number;
  name: string;
  source: string;
  manifest: SkillManifest;
}

/**
 * The pinned skills of the run's agent version that are effective now, in the definition's order
 * (unique, at most {@link PINNED_SKILLS_LIMITS}.count). An id that is not in the model's catalog
 * (`model`: deleted, deselected, its plugin uninstalled, shadowed by an agent skill of the same
 * name) is skipped; one whose current version is manual-only (phase D) is skipped with a warning
 * when `log` is given.
 */
function pinnedCandidates(
  model: readonly ResolvedSkill[],
  agent: Pick<AgentDefinition, "skills">,
  input: Pick<EffectiveSkillsInput, "orgId" | "agentId" | "conversationId">,
  all: readonly ResolvedSkill[],
  log?: Pick<Logger, "warn">,
): PinnedCandidate[] {
  const byId = new Map(model.map((r) => [r.skill.id, r]));
  const manual = new Map(
    all.filter((r) => !invocationOf(r.manifest).model).map((r) => [r.skill.id, r]),
  );
  const out: PinnedCandidate[] = [];
  for (const id of new Set(agent.skills?.pinned ?? [])) {
    const m = manual.get(id);
    if (m) {
      log?.warn("pinned skill is manual-only", {
        orgId: input.orgId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        skillId: id,
        name: m.skill.name,
        version: m.skill.version,
      });
      continue;
    }
    const r = byId.get(id);
    if (!r) continue;
    const { name, version, source } = r.skill;
    out.push({ id, version, name, source, manifest: r.manifest });
    if (out.length >= PINNED_SKILLS_LIMITS.count) break;
  }
  return out;
}

const sameCandidates = (a: readonly PinnedCandidate[], b: readonly PinnedCandidate[]) =>
  a.length === b.length &&
  a.every((p, i) => {
    const q = b[i];
    return q !== undefined && p.id === q.id && p.version === q.version && p.source === q.source;
  });

const storageUnavailable = (message: string) => new ApiError("storage.unavailable", message);

/** `details[0].reason` of a pinned SKILL.md that cannot be used whatever the retries. */
const PINNED_UNREADABLE = "pinned_unreadable";

/** Read attempts per pinned SKILL.md (a transient storage error is retried once). */
const PINNED_READ_ATTEMPTS = 2;

/**
 * The `run_failed` message (shown to the user, English like the other run texts) for a
 * `storage.unavailable` from {@link recordSkillsCatalog}: a pinned SKILL.md that is missing,
 * corrupt or unparsable points at the agent's owner, since sending again cannot help; anything
 * else is a transient storage failure.
 */
export function pinnedFailureText(e: ApiError): string {
  const d = e.details?.[0] as { reason?: string; name?: string } | undefined;
  if (d?.reason === PINNED_UNREADABLE) {
    return `Pinned skill "${d.name}" cannot be read; ask the agent's owner to unpin it or upload it again.`;
  }
  return "File storage is temporarily unavailable, so this agent's pinned skills cannot be read; send the message again later.";
}

/**
 * Reads each pinned skill's SKILL.md from `kernel/<orgId>/<source>SKILL.md`, verifies it against
 * the manifest's size and sha256 and returns the parsed body, in order. Every failure throws
 * `storage.unavailable` (Decision 9: the run fails before any model request):
 * - a read error is retried once ({@link PINNED_READ_ATTEMPTS}), then is transient (the user
 *   sends again);
 * - a manifest without SKILL.md, a missing object, an integrity mismatch, non-UTF-8 or an
 *   unparsable file is permanent: logged at `error` with the skill id and source, and the error
 *   carries `details: [{ reason: "pinned_unreadable", skillId, name, source }]`
 *   ({@link pinnedFailureText} turns it into an owner-facing message).
 */
export async function loadPinnedBodies(
  storage: StorageService,
  orgId: string,
  pinned: readonly PinnedCandidate[],
  opts: { signal?: AbortSignal; log?: Pick<Logger, "error"> } = {},
): Promise<PinnedSkill[]> {
  if (pinned.length === 0) return [];
  storage.assertAvailable();
  const store = storage.kernel(orgId);
  const out: PinnedSkill[] = [];
  for (const p of pinned) {
    const unreadable = (problem: string) => {
      opts.log?.error("pinned skill unreadable", {
        orgId,
        skillId: p.id,
        version: p.version,
        source: p.source,
        problem,
      });
      return new ApiError("storage.unavailable", `Pinned skill ${p.name} ${problem}`, [
        { reason: PINNED_UNREADABLE, skillId: p.id, name: p.name, source: p.source },
      ]);
    };
    const entry = p.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE);
    if (!entry) throw unreadable(`has no ${SKILL_ENTRY_FILE} in its manifest`);
    let bytes: Uint8Array | null = null;
    for (let attempt = 1; bytes === null; attempt++) {
      let got: Awaited<ReturnType<typeof store.get>>;
      try {
        got = await store.get(
          `${p.source}${SKILL_ENTRY_FILE}`,
          opts.signal && { signal: opts.signal },
        );
        if (got) bytes = new Uint8Array(await new Response(got.body).arrayBuffer());
      } catch {
        if (attempt >= PINNED_READ_ATTEMPTS) {
          throw storageUnavailable(`Cannot read pinned skill ${p.name} from storage`);
        }
        continue;
      }
      if (!got) throw unreadable("is missing from storage");
    }
    if (
      bytes.byteLength !== entry.size ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      throw unreadable("failed its integrity check");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unreadable("is not UTF-8");
    }
    const parsed = parseSkillMd(text, { invocationKeys: false });
    if ("errors" in parsed) throw unreadable("cannot be parsed");
    out.push({ id: p.id, version: p.version, name: p.name, source: p.source, body: parsed.body });
  }
  return out;
}

/**
 * The pinned skills that fit: in order while the running total of UTF-8 body bytes stays within
 * {@link PINNED_SKILLS_LIMITS}.totalBytes; the first that does not fit and every later one are
 * dropped with a warning (Review Focus 4: a pinned skill's new version can push a saved set over).
 */
export function fitPinned(
  pinned: readonly PinnedSkill[],
  log: Pick<Logger, "warn"> | undefined,
  input: Partial<Pick<EffectiveSkillsInput, "orgId" | "agentId" | "conversationId">>,
): PinnedSkill[] {
  const enc = new TextEncoder();
  let total = 0;
  for (let i = 0; i < pinned.length; i++) {
    total += enc.encode((pinned[i] as PinnedSkill).body).byteLength;
    if (total > PINNED_SKILLS_LIMITS.totalBytes) {
      log?.warn("pinned skills over the limit", {
        orgId: input.orgId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        kept: pinned.slice(0, i).map((p) => p.name),
        dropped: pinned.slice(i).map((p) => p.name),
        maxBytes: PINNED_SKILLS_LIMITS.totalBytes,
      });
      return pinned.slice(0, i);
    }
  }
  return [...pinned];
}

/** `skills_catalog` 的幂等键：每次运行最多写一份。 */
/**
 * 是否给模型 `skill_load`：日志里有过技能目录快照（Ruling M17），**即使最新一份是空的**。构建请求与执行工具调用
 * 用同一判定。不因空快照收回这个工具：工具集合一变缓存前缀就失效；而且 agent 没有别的工具时会发出「没有工具
 * 但历史里有 tool_use」的请求，Anthropic 会拒绝。空目录下调用 skill_load 由 `NO_SKILLS_TEXT` 给出可执行的说明。
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
  db: KernelDb,
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
 * 在事务 `t` 里锁会话行（与 `EventLog.append` 同一把锁）并读最新一份技能目录快照（没有为 undefined）。
 * 「读最新 → 推出下一份 → 追加」都在这把锁内，别的写快照的事务（运行开始、skill_write、拒绝时的回退）插不进来。
 */
export async function lockLatestCatalog(
  t: Transaction<KernelDatabase>,
  conversationId: string,
): Promise<SkillsSnapshot | undefined> {
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
  return last ? (last.payload as SkillsSnapshot) : undefined;
}

/** How often run start re-resolves when the pinned set changed while its bodies were read. */
const RECORD_ATTEMPTS = 3;

/**
 * 运行开始时记录技能目录快照：解析生效的技能，与日志里最新一份不同才写（带幂等键，崩溃重试不重复）。
 * 从没有快照、现在也没有技能 → 不写（没有技能的 agent 不出现目录）；之前有、现在全没了 → 写空快照（模型据此得知被移除）。
 * 解析、比较、追加在一个事务里、先锁会话行：否则在解析与追加之间提交的拒绝 + 回退快照会被过时的草稿条目盖回去。
 * 解析只读 skills / agents / 申请（不加锁），不会与别的路径形成死锁。
 *
 * Phase B: the snapshot also carries each skill's `plugin`, the pinned skills' bodies (`pinned`)
 * and the Claude Code tool-name map (`toolMap`, iff an effective skill has source format
 * `claude-code`). Pinned bodies are read from object storage outside the transaction (1); inside
 * it the skills are resolved again (2), and when the pinned identities changed meanwhile the
 * whole thing starts over (at most {@link RECORD_ATTEMPTS} times, then `conflict`). A read failure
 * throws `storage.unavailable` before anything is written. Writes only when `!sameSnapshot`.
 */
export async function recordSkillsCatalog(
  deps: {
    db: KernelDb;
    eventLog: Pick<EventLog, "append" | "notify">;
    log?: Pick<Logger, "warn" | "error">;
    /** Reads pinned bodies; without it an agent with pinned skills fails `storage.unavailable`. */
    storage?: StorageService;
  },
  input: EffectiveSkillsInput & { runId: string },
): Promise<void> {
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
    const all = await resolveSkills(deps.db, input);
    // Warn about manual-only pins once, on the first attempt
    const first = pinnedCandidates(
      forModel(all, input),
      input.agent,
      input,
      all,
      attempt === 1 ? deps.log : undefined,
    );
    if (first.length > 0 && !deps.storage) {
      throw storageUnavailable("No object storage to read pinned skills from");
    }
    const pinned = fitPinned(
      deps.storage
        ? await loadPinnedBodies(deps.storage, input.orgId, first, {
            ...(deps.log && { log: deps.log }),
          })
        : [],
      deps.log,
      input,
    );
    const toSeq = await deps.db.transaction().execute(async (t) => {
      const last = await lockLatestCatalog(t, input.conversationId);
      const all = await resolveSkills(t, input);
      const resolved = forModel(all, input, deps.log);
      if (!sameCandidates(first, pinnedCandidates(resolved, input.agent, input, all))) {
        return "retry" as const;
      }
      const skills = resolved.map((r) => r.skill);
      const next: SkillsSnapshot = {
        skills,
        ...(pinned.length > 0 && { pinned }),
        // The model's (truncated) skills as before phase D, plus manual-only ones: a person can
        // invoke one whose body names Claude tools (batch 1 review M8)
        ...([...resolved, ...all.filter((r) => !invocationOf(r.manifest).model)].some(
          (r) => r.format === "claude-code",
        ) && {
          toolMap: CLAUDE_CODE_TOOL_MAP,
        }),
      };
      if (last ? sameSnapshot(last, next) : skills.length === 0) return null;
      const written = await deps.eventLog.append(
        input.conversationId,
        [
          {
            type: "skills_catalog",
            runId: input.runId,
            idemKey: skillsCatalogIdemKey(input.runId),
            payload: next,
          },
        ],
        t,
      );
      return Math.max(...written.map((e) => e.seq));
    });
    if (toSeq === "retry") continue;
    if (toSeq !== null) await deps.eventLog.notify(input.conversationId, toSeq);
    return;
  }
  throw new ApiError(
    "conflict",
    "The pinned skills kept changing while the run started; send the message again.",
  );
}
