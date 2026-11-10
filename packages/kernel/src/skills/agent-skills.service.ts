import { randomUUID } from "node:crypto";
import { parseSkillMd, SKILL_ENTRY_FILE } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { visibleTo } from "../agents/agent-lookup.js";
import { skillFilesPrefix } from "../conversations/attachments.service.js";
import { EventLog } from "../conversations/event-log.js";
import type { SkillManifest } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";
import { invocationOf } from "./catalog.js";
import type { CancelledDrafts } from "./changes.service.js";
import {
  appendConversationCatalog,
  type ConversationCatalogDeps,
  revertTrialCatalog,
} from "./conversation-catalog.js";
import { readSkillPackage, type SkillPackageFile, skillManifest } from "./package.js";

/**
 * The cap on an agent's own skills (`scope = agent`), pending new skills included. Far below the
 * catalog snapshot's cap (`SKILLS_CATALOG_MAX`), so normal use never truncates the catalog.
 */
export const AGENT_SKILLS_MAX = 50;
/** How many skill files are written at once. */
const PUT_CONCURRENCY = 4;

/** Who registers or deletes an agent's skill, and from where. */
export interface AgentSkillActor {
  orgId: string;
  agentId: string;
  /** The person acting (the run's trigger account for an agent). */
  accountId: string;
  /** The conversation that gets a catalog snapshot with the new version (agent registrations). */
  conversationId?: string;
  runId?: string | null;
  actorTokenId?: string;
  /** Merged into the audit detail (e.g. `viaAgent(...)`). */
  auditDetail?: Record<string, unknown>;
}

/** The result of {@link AgentSkillsService.register}. */
export type RegisterOutcome =
  | {
      kind: "version";
      skillId: string;
      name: string;
      version: number;
      created: boolean;
      /** The version is manual-only: not in the model's catalog. */
      manualOnly: boolean;
    }
  | {
      kind: "proposed";
      requestId: string;
      skillId: string;
      name: string;
      version: number;
      manualOnly: boolean;
    };

const agentNotFound = () => new ApiError("agent.not_found", "Agent not found");
const notOwner = () =>
  new ApiError(
    "forbidden",
    "Only this agent's owner can change its skills; tell the user that only the agent's owner can add, update or delete them.",
  );

/** The body of a skill's SKILL.md (as run start would read it); null if unparsable. */
export function skillMdBody(files: readonly { path: string; data: Uint8Array }[]): string | null {
  const md = files.find((f) => f.path === SKILL_ENTRY_FILE);
  if (!md) return null;
  try {
    const parsed = parseSkillMd(new TextDecoder("utf-8", { fatal: true }).decode(md.data));
    return "errors" in parsed ? null : parsed.body;
  } catch {
    return null;
  }
}

/**
 * Takes a KEY SHARE lock on the org row before the agent row is locked: the order `AgentsService`
 * uses (org row FOR UPDATE -> agent row). Without it, a transaction holding the agent row that
 * inserts a row referencing the org (the foreign key takes KEY SHARE) can deadlock with it (40P01).
 */
export async function keyShareOrg(db: KernelDb, orgId: string): Promise<void> {
  await db.selectFrom("orgs").select("id").where("id", "=", orgId).forKeyShare().executeTakeFirst();
}

/**
 * The cap on new agent skills (pending new skills included; `excluding` is a request about to be
 * superseded). At the cap -> 409 `skill.agent_cap`. Runs in the caller's transaction.
 */
export async function assertBelowAgentSkillCap(
  db: KernelDb,
  agentId: string,
  excluding?: string,
): Promise<void> {
  const skills = await db
    .selectFrom("skills")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("scope", "=", "agent")
    .where("agent_id", "=", agentId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  let q = db
    .selectFrom("skill_change_requests")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("agent_id", "=", agentId)
    .where("status", "=", "pending")
    .where("skill_id", "is", null);
  if (excluding !== undefined) q = q.where("id", "!=", excluding);
  const drafts = await q.executeTakeFirstOrThrow();
  if (Number(skills.n) + Number(drafts.n) >= AGENT_SKILLS_MAX) {
    throw new ApiError(
      "skill.agent_cap",
      `This agent already has ${AGENT_SKILLS_MAX} skills (including changes awaiting approval), the maximum; register a new version of an existing skill (same name) instead, or ask the agent's owner to delete one of its skills.`,
    );
  }
}

/** Writes a version of an agent skill and points `current_version` at it (creating the skill). */
export async function createAgentSkillVersion(
  db: KernelDb,
  v: {
    orgId: string;
    agentId: string;
    skillId: string;
    exists: boolean;
    version: number;
    manifest: SkillManifest;
    prefix: string;
    createdBy: string;
  },
): Promise<void> {
  if (v.exists) {
    await db
      .updateTable("skills")
      .set({
        current_version: v.version,
        description: v.manifest.description,
        updated_at: sql`now()`,
      })
      .where("id", "=", v.skillId)
      .execute();
  } else {
    await db
      .insertInto("skills")
      .values({
        id: v.skillId,
        org_id: v.orgId,
        scope: "agent",
        agent_id: v.agentId,
        name: v.manifest.name,
        description: v.manifest.description,
        current_version: v.version,
        created_by: v.createdBy,
      })
      .execute();
  }
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: v.skillId,
      version: v.version,
      manifest: JSON.stringify(v.manifest),
      object_prefix: v.prefix,
      created_by: v.createdBy,
    })
    .execute();
}

/**
 * An agent's own skills (`scope = agent`): only the agent's current owner (read live) registers
 * a zip package as one of them or deletes one; anyone else gets 403 `forbidden` (404
 * `agent.not_found` when the agent is not visible to them).
 *
 * `register` reads the zip with the one package reader (`readSkillPackage`), writes the files under
 * a fresh `skills/<id>/` prefix before the transaction, then in one transaction (lock order org ->
 * agent -> conversation -> skill rows) creates the skill or its next version, audits, and appends a
 * `skills_catalog` snapshot to `conversationId` when given so the same run can `Skill` it at its
 * next step. On failure the prefix is deleted. All state is in PG and object storage.
 */
@Injectable()
export class AgentSkillsService {
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

  /** Registers a zip package as one of the agent's own skills (see the class comment). */
  async register(actor: AgentSkillActor, zip: Uint8Array): Promise<RegisterOutcome> {
    const pkg = await readSkillPackage(zip);
    // Refuse early (re-checked under the lock) so a non-owner writes nothing to storage
    await this.assertOwner(actor.orgId, actor.agentId, actor.accountId);
    this.storage.assertAvailable();
    const prefix = skillFilesPrefix(randomUUID());
    let committed: { outcome: RegisterOutcome; toSeq: number | null };
    try {
      await this.putFiles(actor.orgId, prefix, pkg.files);
      committed = await this.registerIn(actor, pkg, skillManifest(pkg), prefix);
    } catch (e) {
      await this.deletePrefix(actor.orgId, prefix);
      throw e;
    }
    if (committed.toSeq !== null && actor.conversationId !== undefined) {
      await this.eventLog.notify(actor.conversationId, committed.toSeq);
    }
    return committed.outcome;
  }

  /**
   * Soft-deletes one of the agent's own skills (only the agent's current owner; others 403
   * `forbidden`): missing / already deleted / not this agent's -> `skill.not_found`. A pending
   * change of the same name is cancelled with it (a reverting snapshot in the requesting
   * conversation, its draft deleted after the commit). Audits `skill.deleted`. Every conversation
   * drops it at its next run start; the name can then be registered again as a new skill.
   */
  async deleteAgentSkill(
    orgId: string,
    agentId: string,
    skillId: string,
    accountId: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const cancelled = await this.deleteAgentSkillIn(
      orgId,
      agentId,
      skillId,
      accountId,
      actorTokenId,
      auditDetail,
    );
    for (const [conv, seq] of cancelled.seqs) await this.eventLog.notify(conv, seq);
    for (const p of cancelled.prefixes) await this.deletePrefix(orgId, p);
  }

  /**
   * The owner check without a lock (operation prechecks, and before storage writes): a live agent
   * of the org whose current owner is `accountId`; visible but not owned -> 403 `forbidden`, not
   * visible -> 404 `agent.not_found`.
   */
  async assertOwner(orgId: string, agentId: string, accountId: string): Promise<void> {
    await this.checkOwner(orgId, agentId, accountId, false);
  }

  /** Reads the agent row (locked FOR NO KEY UPDATE when `lock`) and applies the owner check. */
  private async checkOwner(
    orgId: string,
    agentId: string,
    accountId: string,
    lock: boolean,
  ): Promise<void> {
    // NO KEY UPDATE, not UPDATE: it serializes the skill writes of one agent but not the foreign
    // key check (FOR KEY SHARE) of a transaction already holding the conversation row locked later
    let q = this.db
      .selectFrom("agents")
      .select(["owner_account_id", "deleted_at"])
      .where("id", "=", agentId)
      .where("org_id", "=", orgId);
    if (lock) q = q.forNoKeyUpdate();
    const agent = await q.executeTakeFirst();
    if (!agent || agent.deleted_at !== null) throw agentNotFound();
    if (agent.owner_account_id === accountId) return;
    // As AgentsService: an agent the actor cannot see -> 404, visible but not owned -> 403
    const visible = await this.db
      .selectFrom("agents")
      .select("id")
      .where("id", "=", agentId)
      .where(visibleTo(accountId))
      .executeTakeFirst();
    if (!visible) throw agentNotFound();
    throw notOwner();
  }

  /** The transaction of {@link register}. */
  @Transactional()
  private async registerIn(
    actor: AgentSkillActor,
    pkg: { name: string; description: string; files: SkillPackageFile[] },
    manifest: SkillManifest,
    prefix: string,
  ): Promise<{ outcome: RegisterOutcome; toSeq: number | null }> {
    await keyShareOrg(this.db, actor.orgId);
    await this.checkOwner(actor.orgId, actor.agentId, actor.accountId, true);
    // Then the conversation row (the snapshot append's lock), still after the agent row
    if (actor.conversationId !== undefined) {
      await this.db
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", actor.conversationId)
        .forUpdate()
        .execute();
    }
    const existing = await this.db
      .selectFrom("skills")
      .select(["id", "current_version"])
      .where("org_id", "=", actor.orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", actor.agentId)
      .where("name", "=", pkg.name)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) await assertBelowAgentSkillCap(this.db, actor.agentId);
    const version = (existing?.current_version ?? 0) + 1;
    const skillId = existing?.id ?? randomUUID();
    await createAgentSkillVersion(this.db, {
      orgId: actor.orgId,
      agentId: actor.agentId,
      skillId,
      exists: existing !== undefined,
      version,
      manifest,
      prefix,
      createdBy: actor.accountId,
    });
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      orgId: actor.orgId,
      action: existing ? "skill.version_created" : "skill.created",
      target: skillId,
      detail: {
        name: pkg.name,
        version,
        files: manifest.files.length,
        agentId: actor.agentId,
        ...(actor.conversationId !== undefined && { conversationId: actor.conversationId }),
        ...actor.auditDetail,
      },
    });
    const forModel = invocationOf(manifest).model;
    let toSeq: number | null = null;
    if (actor.conversationId !== undefined) {
      // The conversation sees the new version at once: this skill replaced / added in its latest
      // snapshot (source = this version's prefix). A pinned entry of it gets the version, source
      // and body just written. A manual-only version is never in the model's catalog: it removes
      // the skill from the snapshot, and its pinned entry goes with it (no longer live)
      const pinnedBody = skillMdBody(pkg.files);
      toSeq = await appendConversationCatalog(
        this.catalogDeps,
        actor.conversationId,
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
        `skills_catalog:register:${prefix}`,
        actor.runId,
      );
    }
    return {
      outcome: {
        kind: "version",
        skillId,
        name: pkg.name,
        version,
        created: !existing,
        manualOnly: !forModel,
      },
      toSeq,
    };
  }

  /** The transaction of {@link deleteAgentSkill}. */
  @Transactional()
  private async deleteAgentSkillIn(
    orgId: string,
    agentId: string,
    skillId: string,
    accountId: string,
    actorTokenId: string | undefined,
    auditDetail?: Record<string, unknown>,
  ): Promise<CancelledDrafts> {
    await keyShareOrg(this.db, orgId);
    await this.checkOwner(orgId, agentId, accountId, true);
    const r = await this.db
      .updateTable("skills")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", skillId)
      .where("org_id", "=", orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", agentId)
      .where("deleted_at", "is", null)
      .returning(["name"])
      .executeTakeFirst();
    if (!r) throw new ApiError("skill.not_found", "Skill not found");
    const out: CancelledDrafts = { prefixes: [], seqs: [] };
    const pend = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("status", "=", "pending")
      .where(sql<string>`proposed_version -> 'manifest' ->> 'name'`, "=", r.name)
      .forUpdate()
      .executeTakeFirst();
    if (pend) {
      await this.db
        .updateTable("skill_change_requests")
        .set({ status: "cancelled", decided_at: sql<Date>`now()` })
        .where("id", "=", pend.id)
        .execute();
      await audit(this.db.db, {
        actorAccountId: accountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "skill.change_decided",
        target: pend.id,
        detail: { decision: "cancelled", reason: "skill_deleted", agentId, name: r.name },
      });
      const seq = await revertTrialCatalog(this.catalogDeps, pend);
      if (seq !== null) out.seqs.push([pend.requested_in_conversation, seq]);
      out.prefixes.push(pend.object_prefix);
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "skill.deleted",
      target: skillId,
      detail: { name: r.name, agentId, ...auditDetail },
    });
    return out;
  }

  /** Writes the files under `prefix` in the org's kernel space, a few at a time. */
  private async putFiles(orgId: string, prefix: string, files: SkillPackageFile[]): Promise<void> {
    const store = this.storage.kernel(orgId);
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

  /** Deletes objects best effort (a failure is only logged: org data cleanup removes orphans). */
  private async deletePrefix(orgId: string, prefix: string): Promise<void> {
    try {
      await this.storage.kernel(orgId).deletePrefix(prefix);
    } catch (err) {
      this.log.warn("skill files cleanup failed", { orgId, prefix, err });
    }
  }
}
