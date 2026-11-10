import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import { skillFilesPrefix } from "../conversations/attachments.service.js";
import { EventLog } from "../conversations/event-log.js";
import type {
  ProposedSkillVersion,
  SkillChangeRequestsTable,
  SkillManifest,
} from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";
import { BUILTIN } from "../tools/builtin-names.js";
import {
  AGENT_SKILLS_MAX,
  assertBelowAgentSkillCap,
  createAgentSkillVersion,
  keyShareOrg,
  skillMdBody,
} from "./agent-skills.service.js";
import { invocationOf } from "./catalog.js";
import {
  appendConversationCatalog,
  type ConversationCatalogDeps,
  revertTrialCatalog,
} from "./conversation-catalog.js";

/** 写技能文件时的并发数。 */
const PUT_CONCURRENCY = 4;
/** 详情里读取文件内容的上限（草稿 ≤ 1MB，留余量）。 */
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
/** 收件箱一次最多返回的技能变更数。 */
export const SKILL_CHANGES_LIST_MAX = 100;

export type SkillChangeStatus = "pending" | "approved" | "rejected" | "cancelled";

/** 一条技能变更申请（列表 / 收件箱）。 */
export interface SkillChangeView {
  id: string;
  orgId: string;
  agent: { id: string; name: string };
  /** 已有技能的 id；新技能为 null（批准后才有）。 */
  skillId: string | null;
  name: string;
  description: string;
  /** 批准后预期的版本号。 */
  version: number;
  files: { path: string; size: number }[];
  status: SkillChangeStatus;
  requestedBy: string;
  /** 发起人的显示名（账号已不存在时为空串）。 */
  requestedByName: string;
  requestedInConversation: string;
  /** 网页中发起对话的路径（不含语言前缀）。 */
  conversationPath: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** 详情里的一个文件：文本内容读不到（已删除、超出读取上限）时为 null。 */
export interface SkillChangeFile {
  path: string;
  size: number;
  content: string | null;
}

/**
 * 详情：每个文件附文本内容（草稿已删除时为 null）；`current` 是改动已有技能时该技能当前生效的版本
 * （网页据此显示差异），新技能或技能已删除时为 null。
 */
export interface SkillChangeDetail extends Omit<SkillChangeView, "files"> {
  files: SkillChangeFile[];
  current: { version: number; files: SkillChangeFile[] } | null;
}

/** {@link SkillChangesService.write} 的调用上下文（来自工具调用）。 */
export interface SkillWriteContext {
  orgId: string;
  agentId: string;
  /** 触发本次运行的人。 */
  accountId: string;
  conversationId: string;
  runId?: string;
}

/** 已合成、已校验的技能（见 tools/builtins/skill-write.ts 的 `buildSkillWrite`）。 */
export interface SkillWritePackage {
  name: string;
  description: string;
  files: { path: string; data: Uint8Array; size: number }[];
  manifest: SkillManifest;
}

/** 写技能的结果：私有 agent 直接生成版本，共享 agent 生成变更申请。 */
export type SkillWriteOutcome =
  | { kind: "version"; skillId: string; version: number; created: boolean }
  | { kind: "requested"; requestId: string; skillId: string; version: number };

/** 被取消的草稿：提交后要删的对象前缀与要发布的（对话, seq）。 */
export interface CancelledDrafts {
  prefixes: string[];
  seqs: [string, number][];
}

// ---- 模型可见文案（英文） ----

const STORAGE_UNAVAILABLE_TEXT =
  "File storage is temporarily unavailable, so the skill could not be saved; retry later.";
const pendingElsewhereText = (name: string) =>
  `Skill "${name}" already has a change awaiting the owner's approval (requested in another conversation), so it cannot be changed now; ask the user to have the owner decide that change first, or use a different skill name.`;
const capText = () =>
  `This agent already has ${AGENT_SKILLS_MAX} skills (including changes awaiting approval), the maximum; update an existing skill instead, or ask the agent's owner to delete one of this agent's skills.`;
const AGENT_GONE_TEXT =
  "This agent no longer exists, so the skill cannot be saved; ask the user to start a conversation with another agent.";

const iso = (v: Date | string): string => new Date(v).toISOString();
const notFound = () => new ApiError("skill_change.not_found", "Skill change not found");

/**
 * agent 自写技能与共享 agent 的技能变更审批（M5 T15，R4）：
 * - `write`（工具 `SkillWrite` 调用）：私有 agent 直接生成新版本；共享 agent 生成一条待负责人批准的申请，
 *   期间只有发起对话试用（`resolveEffectiveSkills` 按对话合并）；两种情况都在同一事务里往发起对话追加一份
 *   技能目录快照（Ruling M17：日志是唯一事实源），同一运行的下一步即可 `Skill`；
 * - `decide`（HTTP，只有该 agent 当前的负责人）：批准 → 版本对所有对话生效（各对话下一次运行开始时写新快照）；
 *   拒绝 → 删除草稿对象，发起对话下一次运行开始时目录回到当前版本；
 * - 同一 agent 的同名技能最多一条待处理申请：同一对话再写取代旧的（旧的 cancelled、草稿删除、技能 id 不变），
 *   别的对话再写被拒绝（英文说明）。
 * 状态都在 PG（agent 行锁串行化同一 agent 的写与决定），文件在对象存储 `kernel/<orgId>/skills/<id>/`；无进程内状态。
 */
@Injectable()
export class SkillChangesService {
  private readonly catalogDeps: ConversationCatalogDeps;

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    this.catalogDeps = { db, log, eventLog };
  }

  /** 写技能（见类注释）。模型可见的失败抛 `ToolError`。 */
  async write(ctx: SkillWriteContext, pkg: SkillWritePackage): Promise<SkillWriteOutcome> {
    let store: ReturnType<StorageService["kernel"]>;
    try {
      this.storage.assertAvailable();
      store = this.storage.kernel(ctx.orgId);
    } catch (e) {
      throw storageError(e);
    }
    const id = randomUUID();
    const prefix = skillFilesPrefix(id);
    try {
      await putAll(store, prefix, pkg.files);
    } catch (e) {
      await this.deletePrefix(ctx.orgId, prefix);
      throw storageError(e);
    }
    let committed: { outcome: SkillWriteOutcome; drop: string[]; toSeq: number | null };
    try {
      committed = await this.writeIn(ctx, pkg, id, prefix);
    } catch (e) {
      await this.deletePrefix(ctx.orgId, prefix);
      throw e;
    }
    if (committed.toSeq !== null) {
      await this.eventLog.notify(ctx.conversationId, committed.toSeq);
    }
    for (const p of committed.drop) await this.deletePrefix(ctx.orgId, p);
    return committed.outcome;
  }

  /**
   * 负责人决定一条申请：只有该 agent 当前的负责人（实时读）能决定，其他人 → 403 `skill_change.not_owner`；
   * 已处理 → 409 `skill_change.already_decided`；agent 已删除或申请不在本组织 → 404。
   * 批准：在同一事务里新增版本（技能不存在则用预先分配的 id 新建）、`current_version` 指向它，草稿对象原样成为版本文件；
   * 拒绝：提交后删除草稿对象。审计 `skill.change_decided`。
   */
  async decide(
    orgId: string,
    id: string,
    accountId: string,
    body: { decision: "approve" | "reject"; note?: string | undefined },
    actorTokenId?: string,
  ): Promise<SkillChangeView> {
    const head = await this.db
      .selectFrom("skill_change_requests")
      .select("agent_id")
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!head) throw notFound();
    const done = await this.decideIn(orgId, id, accountId, body, actorTokenId, head.agent_id);
    const row = done.updated;
    if (done.revertSeq !== null) {
      await this.eventLog.notify(row.requested_in_conversation, done.revertSeq);
    }
    if (row.status === "rejected") await this.deletePrefix(orgId, row.object_prefix);
    const [view] = await this.views([row]);
    if (!view) throw notFound();
    return view;
  }

  /** The transaction of {@link write}. */
  @Transactional()
  private async writeIn(
    ctx: SkillWriteContext,
    pkg: SkillWritePackage,
    id: string,
    prefix: string,
  ): Promise<{ outcome: SkillWriteOutcome; drop: string[]; toSeq: number | null }> {
    await keyShareOrg(this.db, ctx.orgId);
    // NO KEY UPDATE, not UPDATE (here, in decide and in AgentSkillsService): it still serializes
    // the writes and decisions of one agent, but not the foreign key check (FOR KEY SHARE) of a
    // transaction that already holds the conversation row this one locks last, e.g. an event
    // log append updating that row a second time (the title job): FOR UPDATE made that 40P01
    const agent = await this.db
      .selectFrom("agents")
      .select(["visibility", "deleted_at"])
      .where("id", "=", ctx.agentId)
      .where("org_id", "=", ctx.orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!agent || agent.deleted_at !== null) throw new ToolError(AGENT_GONE_TEXT);
    // Then the conversation row (appendConversationCatalog's lock, still after the agent row like decide),
    // before the change request insert: its foreign key check takes FOR KEY SHARE on that row,
    // and upgrading to FOR UPDATE afterwards deadlocked with another writer doing the same
    await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", ctx.conversationId)
      .forUpdate()
      .execute();
    const existing = await this.db
      .selectFrom("skills")
      .select(["id", "current_version"])
      .where("org_id", "=", ctx.orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", ctx.agentId)
      .where("name", "=", pkg.name)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    const pend = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("agent_id", "=", ctx.agentId)
      .where("status", "=", "pending")
      .where(sql<string>`proposed_version -> 'manifest' ->> 'name'`, "=", pkg.name)
      .forUpdate()
      .executeTakeFirst();
    const drop: string[] = [];
    if (pend) {
      if (pend.requested_in_conversation !== ctx.conversationId) {
        throw new ToolError(pendingElsewhereText(pkg.name));
      }
      // 同一对话再写：取代旧申请
      await this.db
        .updateTable("skill_change_requests")
        .set({ status: "cancelled", decided_at: sql<Date>`now()` })
        .where("id", "=", pend.id)
        .execute();
      drop.push(pend.object_prefix);
      await audit(this.db.db, {
        actorAccountId: ctx.accountId,
        orgId: ctx.orgId,
        action: "skill.change_decided",
        target: pend.id,
        detail: {
          decision: "cancelled",
          reason: "superseded",
          supersededBy: id,
          agentId: ctx.agentId,
          name: pkg.name,
        },
      });
    }
    if (!existing) {
      try {
        await assertBelowAgentSkillCap(this.db, ctx.agentId, pend?.id);
      } catch (e) {
        if (e instanceof ApiError && e.code === "skill.agent_cap") throw new ToolError(capText());
        throw e;
      }
    }
    const version = (existing?.current_version ?? 0) + 1;
    const skillId = existing?.id ?? pend?.proposed_version.skillId ?? randomUUID();
    let outcome: SkillWriteOutcome;
    if (agent.visibility === "private") {
      await createAgentSkillVersion(this.db, {
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        skillId,
        exists: existing !== undefined,
        version,
        manifest: pkg.manifest,
        prefix,
        createdBy: ctx.accountId,
      });
      await audit(this.db.db, {
        actorAccountId: ctx.accountId,
        orgId: ctx.orgId,
        action: existing ? "skill.version_created" : "skill.created",
        target: skillId,
        detail: {
          name: pkg.name,
          version,
          files: pkg.manifest.files.length,
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
          via: BUILTIN.SkillWrite,
        },
      });
      outcome = { kind: "version", skillId, version, created: !existing };
    } else {
      const proposed: ProposedSkillVersion = { skillId, version, manifest: pkg.manifest };
      await this.db
        .insertInto("skill_change_requests")
        .values({
          id,
          org_id: ctx.orgId,
          agent_id: ctx.agentId,
          skill_id: existing?.id ?? null,
          proposed_version: JSON.stringify(proposed),
          object_prefix: prefix,
          requested_by_account: ctx.accountId,
          requested_in_conversation: ctx.conversationId,
          decided_by: null,
        })
        .execute();
      await audit(this.db.db, {
        actorAccountId: ctx.accountId,
        orgId: ctx.orgId,
        action: "skill.change_requested",
        target: id,
        detail: {
          agentId: ctx.agentId,
          skillId: existing?.id ?? null,
          name: pkg.name,
          version,
          files: pkg.manifest.files.length,
          conversationId: ctx.conversationId,
        },
      });
      outcome = { kind: "requested", requestId: id, skillId, version };
    }
    // 本对话立即看到新版本：在上一份快照上替换 / 加入这个技能（确定、来自日志；来源 = 本次的对象前缀）
    // A pinned entry of this skill gets the version, source and body just written (phase B)
    // A manual-only version (phase D) is never in the model's catalog: it removes the skill from
    // the snapshot instead, and appendConversationCatalog drops its pinned entry with it (no longer live)
    const forModel = invocationOf(pkg.manifest).model;
    const pinnedBody = skillMdBody(pkg.files);
    const toSeq = await appendConversationCatalog(
      this.catalogDeps,
      ctx.conversationId,
      (base) => ({
        ...base,
        skills: [
          ...base.skills.filter((s) => s.name !== pkg.name),
          ...(forModel
            ? [
                {
                  id: skillId,
                  name: pkg.name,
                  description: pkg.description,
                  version,
                  source: prefix,
                },
              ]
            : []),
        ],
        ...(base.pinned && {
          pinned: base.pinned.map((p) =>
            p.id === skillId && pinnedBody !== null
              ? { id: skillId, version, name: pkg.name, source: prefix, body: pinnedBody }
              : p,
          ),
        }),
      }),
      `skills_catalog:write:${id}`,
      ctx.runId,
    );
    return { outcome, drop, toSeq };
  }

  /** The transaction of {@link decide}. */
  @Transactional()
  private async decideIn(
    orgId: string,
    id: string,
    accountId: string,
    body: { decision: "approve" | "reject"; note?: string | undefined },
    actorTokenId: string | undefined,
    agentId: string,
  ): Promise<{ updated: Selectable<SkillChangeRequestsTable>; revertSeq: number | null }> {
    // 加锁顺序与 write 一致：组织行（KEY SHARE）→ agent 行 → 申请行 → 会话行
    await keyShareOrg(this.db, orgId);
    const agent = await this.db
      .selectFrom("agents")
      .select(["owner_account_id", "deleted_at"])
      .where("id", "=", agentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!agent || agent.deleted_at !== null) throw notFound();
    const req = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    // 首次读与加锁重读之间行被删了（agent / 组织被硬删除）→ 404，不是 500
    if (!req) throw notFound();
    if (agent.owner_account_id !== accountId) {
      throw new ApiError(
        "skill_change.not_owner",
        "Only the agent's owner can decide on its skill changes",
      );
    }
    if (req.status !== "pending") {
      throw new ApiError(
        "skill_change.already_decided",
        "This skill change has already been decided",
      );
    }
    const p = req.proposed_version;
    const approved = body.decision === "approve";
    let skillId = req.skill_id;
    let version = p.version;
    if (approved) {
      const existing = await this.db
        .selectFrom("skills")
        .select(["id", "current_version"])
        .where("org_id", "=", orgId)
        .where("scope", "=", "agent")
        .where("agent_id", "=", req.agent_id)
        .where("name", "=", p.manifest.name)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      skillId = existing?.id ?? p.skillId;
      version = (existing?.current_version ?? 0) + 1;
      await createAgentSkillVersion(this.db, {
        orgId,
        agentId: req.agent_id,
        skillId,
        exists: existing !== undefined,
        version,
        manifest: p.manifest,
        prefix: req.object_prefix,
        createdBy: req.requested_by_account,
      });
    }
    const updated = await this.db
      .updateTable("skill_change_requests")
      .set({
        status: approved ? "approved" : "rejected",
        decided_by: accountId,
        decided_at: sql<Date>`now()`,
        ...(approved && { skill_id: skillId }),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "skill.change_decided",
      target: id,
      detail: {
        decision: approved ? "approved" : "rejected",
        agentId: req.agent_id,
        skillId,
        name: p.manifest.name,
        version: approved ? version : p.version,
        requestedBy: req.requested_by_account,
        conversationId: req.requested_in_conversation,
        ...(body.note !== undefined && { note: body.note }),
      },
    });
    // 拒绝：发起对话立即回退到正式版本（或移除），模型在当前位置看到提醒
    const revertSeq = approved ? null : await revertTrialCatalog(this.catalogDeps, req);
    return { updated, revertSeq };
  }

  /** 当前用户（作为 agent 负责人）能决定的待处理申请，新的在前，最多 {@link SKILL_CHANGES_LIST_MAX} 条。 */
  async listPending(orgId: string, accountId: string): Promise<SkillChangeView[]> {
    const rows = await this.db
      .selectFrom("skill_change_requests")
      .innerJoin("agents", "agents.id", "skill_change_requests.agent_id")
      .selectAll("skill_change_requests")
      .where("skill_change_requests.org_id", "=", orgId)
      .where("skill_change_requests.status", "=", "pending")
      .where("agents.owner_account_id", "=", accountId)
      .where("agents.deleted_at", "is", null)
      .orderBy("skill_change_requests.created_at", "desc")
      .limit(SKILL_CHANGES_LIST_MAX)
      .execute();
    return this.views(rows);
  }

  /**
   * 详情（含文件文本）：只有该 agent 的负责人与发起人能看，其他人一律 404（不泄露存在）。
   * 草稿对象已删除（拒绝 / 取消）时文件内容为 null。
   */
  async get(orgId: string, id: string, accountId: string): Promise<SkillChangeDetail> {
    const row = await this.db
      .selectFrom("skill_change_requests")
      .innerJoin("agents", "agents.id", "skill_change_requests.agent_id")
      .selectAll("skill_change_requests")
      .select("agents.owner_account_id")
      .where("skill_change_requests.id", "=", id)
      .where("skill_change_requests.org_id", "=", orgId)
      .where("agents.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.owner_account_id !== accountId && row.requested_by_account !== accountId) {
      throw notFound();
    }
    const [view] = await this.views([row]);
    if (!view) throw notFound();
    const live = row.status === "pending" || row.status === "approved";
    const store = this.storage.kernel(orgId);
    const budget = { left: DETAIL_MAX_BYTES };
    const files = await readTexts(
      live ? store : undefined,
      row.object_prefix,
      row.proposed_version.manifest.files,
      budget,
    );
    // 改动已有技能：附上当前生效版本的文件（批准后它就是上一版，差异仍按申请时的当前版本显示）
    let current: SkillChangeDetail["current"] = null;
    if (row.skill_id !== null) {
      const cur = await this.db
        .selectFrom("skills")
        .innerJoin("skill_versions", (j) =>
          j
            .onRef("skill_versions.skill_id", "=", "skills.id")
            .onRef("skill_versions.version", "=", "skills.current_version"),
        )
        .select([
          "skill_versions.version",
          "skill_versions.manifest",
          "skill_versions.object_prefix",
        ])
        .where("skills.id", "=", row.skill_id)
        .where("skills.deleted_at", "is", null)
        .executeTakeFirst();
      // 已批准的申请自己就是当前版本：没有可比的「之前」，不给
      if (cur && cur.object_prefix !== row.object_prefix) {
        current = {
          version: cur.version,
          files: await readTexts(store, cur.object_prefix, cur.manifest.files, budget),
        };
      }
    }
    return { ...view, files, current };
  }

  /**
   * In the caller's transaction (`mandatory`: `AgentsService.softDelete` holds the org and agent
   * row locks), cancels every pending skill change of the agent: marks them cancelled, audits, and
   * appends a reverting snapshot to each requesting conversation. After the commit the caller runs
   * {@link finishCancel} to delete the drafts and publish the events.
   */
  @Transactional({ propagation: "mandatory" })
  async cancelPendingForAgent(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    reason: string,
    actorTokenId?: string,
  ): Promise<CancelledDrafts> {
    const rows = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("agent_id", "=", agentId)
      .where("status", "=", "pending")
      .orderBy("created_at")
      .forUpdate()
      .execute();
    const out: CancelledDrafts = { prefixes: [], seqs: [] };
    for (const r of rows) {
      await this.db
        .updateTable("skill_change_requests")
        .set({ status: "cancelled", decided_at: sql<Date>`now()` })
        .where("id", "=", r.id)
        .execute();
      await audit(this.db.db, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "skill.change_decided",
        target: r.id,
        detail: { decision: "cancelled", reason, agentId, name: r.proposed_version.manifest.name },
      });
      const seq = await revertTrialCatalog(this.catalogDeps, r);
      if (seq !== null) out.seqs.push([r.requested_in_conversation, seq]);
      out.prefixes.push(r.object_prefix);
    }
    return out;
  }

  /** {@link cancelPendingForAgent} 提交之后：发布事件、尽力删除草稿对象。 */
  async finishCancel(orgId: string, c: CancelledDrafts): Promise<void> {
    for (const [conv, seq] of c.seqs) await this.eventLog.notify(conv, seq);
    for (const p of c.prefixes) await this.deletePrefix(orgId, p);
  }

  /** 尽力删除草稿对象（失败只记日志：孤儿对象随组织数据清理删除）。 */
  private async deletePrefix(orgId: string, prefix: string): Promise<void> {
    try {
      await this.storage.kernel(orgId).deletePrefix(prefix);
    } catch (err) {
      this.log.warn("skill draft cleanup failed", { orgId, prefix, err });
    }
  }

  /** 补齐 agent 名。 */
  private async views(rows: Selectable<SkillChangeRequestsTable>[]): Promise<SkillChangeView[]> {
    if (rows.length === 0) return [];
    const agentIds = [...new Set(rows.map((r) => r.agent_id))];
    const agents = await this.db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select(["agents.id", "agent_versions.definition"])
      .where("agents.id", "in", agentIds)
      .execute();
    const requesters = await this.db
      .selectFrom("accounts")
      .select(["id", "display_name"])
      .where("id", "in", [...new Set(rows.map((r) => r.requested_by_account))])
      .execute();
    const requesterNames = new Map(requesters.map((a) => [a.id, a.display_name]));
    const names = new Map(
      agents.map((a) => {
        const n = (a.definition as { name?: unknown } | null)?.name;
        return [a.id, typeof n === "string" ? n : ""];
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      agent: { id: r.agent_id, name: names.get(r.agent_id) ?? "" },
      skillId: r.skill_id,
      name: r.proposed_version.manifest.name,
      description: r.proposed_version.manifest.description,
      version: r.proposed_version.version,
      files: r.proposed_version.manifest.files.map((f) => ({ path: f.path, size: f.size })),
      status: r.status,
      requestedBy: r.requested_by_account,
      requestedByName: requesterNames.get(r.requested_by_account) ?? "",
      requestedInConversation: r.requested_in_conversation,
      conversationPath: `/chat/${r.requested_in_conversation}`,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at === null ? null : iso(r.decided_at),
      createdAt: iso(r.created_at),
    }));
  }
}

/**
 * 按清单顺序读文件文本，共用读取额度 `budget`（超出、对象缺失、存储出错时该文件内容为 null）。
 * `store` 为 undefined 表示不读（如草稿已删除）。
 */
async function readTexts(
  store: ReturnType<StorageService["kernel"]> | undefined,
  prefix: string,
  manifest: readonly { path: string; size: number }[],
  budget: { left: number },
): Promise<SkillChangeFile[]> {
  const out: SkillChangeFile[] = [];
  for (const f of manifest) {
    let content: string | null = null;
    if (store && f.size <= budget.left) {
      try {
        const got = await store.get(`${prefix}${f.path}`);
        if (got) {
          content = await new Response(got.body).text();
          budget.left -= f.size;
        }
      } catch {
        content = null;
      }
    }
    out.push({ path: f.path, size: f.size, content });
  }
  return out;
}

/** 并发写入全部文件。 */
async function putAll(
  store: ReturnType<StorageService["kernel"]>,
  prefix: string,
  files: SkillWritePackage["files"],
): Promise<void> {
  const queue = [...files];
  await Promise.all(
    Array.from({ length: Math.min(PUT_CONCURRENCY, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        await store.put(`${prefix}${f.path}`, f.data, {
          contentType: "application/octet-stream",
          size: f.size,
        });
      }
    }),
  );
}

/** 存储错误 → 给模型的说明（存储不可用可重试）；其余原样抛出。 */
function storageError(e: unknown): unknown {
  if (e instanceof ApiError && e.code === "storage.unavailable") {
    return new ToolError(STORAGE_UNAVAILABLE_TEXT);
  }
  return e;
}
