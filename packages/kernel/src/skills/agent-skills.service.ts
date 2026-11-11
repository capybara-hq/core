import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { visibleTo } from "../agents/agent-lookup.js";
import { normalizeStoredDefinition } from "../agents/definition.js";
import { offeredNamed } from "../catalog/component-state.js";
import {
  AttachmentsService,
  type CreatedAttachment,
  SKILL_PACKAGE_CONTENT_TYPE,
  skillFilesPrefix,
} from "../conversations/attachments.service.js";
import { EventLog } from "../conversations/event-log.js";
import type { KernelSchemaDb, SkillManifest } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { assertCustomAllowed } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { roleAtLeast } from "../orgs/roles.js";
import type { SkillsSnapshot } from "../runtime/context/skills.js";
import { StorageService } from "../storage/storage.service.js";
import { invocationOf } from "./catalog.js";
import {
  appendConversationCatalog,
  type CancelledDrafts,
  type ConversationCatalogDeps,
  cancelRequestIn,
} from "./conversation-catalog.js";
import {
  readSkillPackage,
  type SkillPackageFile,
  type SkillPackageInput,
  skillManifest,
} from "./package.js";
import { SkillsService } from "./skills.service.js";
import { agentSkills } from "./usable.js";

/**
 * The cap on an agent's own skills (`scope = agent`). Far below the catalog snapshot's cap
 * (`SKILLS_CATALOG_MAX`), so normal use never truncates the catalog. Requests never add agent
 * skills (a share moves an existing one out, a version proposal targets an org skill), so they
 * do not count.
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
      /** A version proposal on a shared org skill the actor maintains, for an org admin to decide. */
      kind: "proposed";
      requestId: string;
      skillId: string;
      name: string;
      version: number;
      manualOnly: boolean;
    };

/** The result of {@link AgentSkillsService.share}. */
export type ShareOutcome =
  | { kind: "shared"; skillId: string }
  | { kind: "requested"; requestId: string };

const agentNotFound = () => new ApiError("agent.not_found", "Agent not found");
const notOwner = () => new ApiError("forbidden", "Only the agent's owner can change its skills.");
const skillNotFound = () => new ApiError("skill.not_found", "Skill not found");

/** Whether the account is an admin (or owner) of the org, read live. */
export async function isOrgAdmin(
  db: KernelSchemaDb,
  orgId: string,
  accountId: string,
): Promise<boolean> {
  const m = await db
    .selectFrom("memberships")
    .select("role")
    .where("org_id", "=", orgId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return m !== undefined && roleAtLeast(m.role, "admin");
}

/**
 * In the caller's transaction, refuses sharing a skill named `name` when the org already has a
 * live org skill of that name or a platform skill of that name is offered to the org (409
 * `skill.name_exists`): skill names are unique in an org.
 */
export async function assertShareableName(
  db: KernelDb,
  orgId: string,
  name: string,
): Promise<void> {
  const taken = await db
    .selectFrom("skills")
    .select("id")
    .where("org_id", "=", orgId)
    .where("scope", "=", "org")
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const offered = taken ? [] : await offeredNamed(db.db, orgId, "skill", name);
  if (taken || offered.length > 0) {
    throw new ApiError(
      "skill.name_exists",
      `The organization already has a skill named "${name}"; rename this skill (register it again under another name) before sharing it.`,
    );
  }
}

/**
 * In the caller's transaction (the skill row locked), turns an agent skill into an org skill: the
 * org owns it, `agent_id` is cleared, the agent it came from and its maintainer are recorded.
 * Its versions stay.
 */
export async function shareSkillIn(
  db: KernelDb,
  v: { skillId: string; agentId: string; maintainerAccountId: string },
): Promise<void> {
  await db
    .updateTable("skills")
    .set({
      scope: "org",
      agent_id: null,
      origin_agent_id: v.agentId,
      maintainer_account_id: v.maintainerAccountId,
      updated_at: sql`now()`,
    })
    .where("id", "=", v.skillId)
    .execute();
}

/**
 * The catalog snapshot `base` with skill `name` replaced by the version just written or proposed
 * (`source` = its prefix), or removed when that version is manual-only. Pinned skills of an old
 * snapshot are not carried (skills default-on spec §8).
 */
function withVersion(
  base: SkillsSnapshot,
  v: {
    skillId: string;
    name: string;
    description: string;
    version: number;
    source: string;
    forModel: boolean;
  },
): SkillsSnapshot {
  return {
    ...base,
    skills: [
      ...base.skills.filter((s) => s.name !== v.name),
      ...(v.forModel
        ? [
            {
              id: v.skillId,
              name: v.name,
              description: v.description,
              version: v.version,
              source: v.source,
            },
          ]
        : []),
    ],
  };
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
 * The cap on new agent skills: at {@link AGENT_SKILLS_MAX} live own skills -> 409
 * `skill.agent_cap`. Runs in the caller's transaction.
 */
export async function assertBelowAgentSkillCap(db: KernelDb, agentId: string): Promise<void> {
  const skills = await db
    .selectFrom("skills")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("scope", "=", "agent")
    .where("agent_id", "=", agentId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  if (Number(skills.n) >= AGENT_SKILLS_MAX) {
    throw new ApiError(
      "skill.agent_cap",
      `This agent already has ${AGENT_SKILLS_MAX} skills, the maximum; register a new version of an existing skill (same name) instead, or ask the agent's owner to delete one of its skills.`,
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
 * a zip package as one of them, deletes one or shares one with the org; anyone else gets 403
 * `forbidden` (404 `agent.not_found` when the agent is not visible to them).
 *
 * `register` reads the zip with the one package reader (`readSkillPackage`), writes the files under
 * a fresh `skills/<id>/` prefix before the transaction, then in one transaction (lock order org ->
 * agent -> conversation -> skill rows -> request rows) creates the skill or its next version,
 * audits, and appends a `skills_catalog` snapshot to `conversationId` when given so the same run
 * can `Skill` it at its next step. On failure the prefix is deleted. A package named like a shared
 * org skill the actor maintains (and the agent has no own skill of that name) is a new version of
 * that org skill instead (spec §5.5): an org admin's applies at once, anyone else's becomes a
 * version proposal an org admin decides, tried only in the proposing conversation.
 *
 * `share` (spec §5.4) turns an agent skill into an org skill at once when the owner is an org
 * admin, else records a share request for the org admins. All state is in PG and object storage.
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
    /** An org admin maintainer's version of a shared skill is an org skill version. */
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
  ) {
    this.catalogDeps = { db, log, eventLog };
  }

  /**
   * Registers a skill package upload onto an agent (presigned, `application/zip`, <= 50 MB): only
   * the agent's current owner (403 `forbidden`, 404 `agent.not_found` when not visible). Agent
   * skills are not governed by the deployment's `customSkills` setting, so it is not checked.
   */
  async createAgentUpload(
    orgId: string,
    accountId: string,
    agentId: string,
    input: { name: string; size: number },
  ): Promise<CreatedAttachment> {
    await this.assertOwner(orgId, agentId, accountId);
    return this.attachments.create(
      orgId,
      accountId,
      { name: input.name, contentType: SKILL_PACKAGE_CONTENT_TYPE, size: input.size },
      "skill-package",
    );
  }

  /**
   * Registers an uploaded package as one of the agent's own skills ({@link register}): the owner
   * is checked before the upload is read (a non-owner learns nothing about it), the zip is read
   * from the uploader's own upload (`attachment.not_found` otherwise) and the upload is consumed
   * in the register transaction (of concurrent requests for it only one registers).
   */
  async registerAgentUpload(
    orgId: string,
    accountId: string,
    agentId: string,
    uploadId: string,
    actorTokenId?: string,
  ): Promise<RegisterOutcome> {
    await this.assertOwner(orgId, agentId, accountId);
    const zip = await this.attachments.readSkillPackage(orgId, accountId, uploadId);
    return this.register(
      { orgId, agentId, accountId, ...(actorTokenId !== undefined && { actorTokenId }) },
      zip,
      { inTransaction: () => this.attachments.consumeSkillPackage(orgId, accountId, uploadId) },
    );
  }

  /**
   * Registers a zip package as one of the agent's own skills, or as a new version of a shared org
   * skill the actor maintains (see the class comment). `opts.inTransaction` runs in the register
   * transaction after the agent row lock, before the skill rows (e.g. consuming the upload the zip
   * came from, so a concurrent retry of the same upload registers nothing).
   *
   * A version proposal refuses with 409 `skill.proposal_pending_elsewhere` while another
   * conversation (or another agent of the maintainer) has a pending proposal of that skill; one
   * pending from the same conversation is superseded (cancelled, its draft deleted). Versions of a
   * shared skill (proposed or applied) are refused while `customSkills` is denied. A new own skill
   * named like an org skill the agent uses (not maintained by the actor) -> 409
   * `skill.name_exists`. A new version of an own skill cancels its pending share request.
   */
  async register(
    actor: AgentSkillActor,
    zip: Uint8Array,
    opts: { inTransaction?: () => Promise<void> } = {},
  ): Promise<RegisterOutcome> {
    const pkg = await readSkillPackage(zip);
    // Refuse early (re-checked under the lock) so a non-owner writes nothing to storage
    await this.assertOwner(actor.orgId, actor.agentId, actor.accountId);
    this.storage.assertAvailable();
    if (await this.appliesToOrgSkill(actor, pkg.name)) {
      // A shared skill is an org skill: refused while custom org skills are denied
      await assertCustomAllowed(this.db.db, "customSkills");
      const claimed = await this.claimIn(actor, pkg.name, opts.inTransaction);
      if (claimed !== null) {
        for (const [conv, seq] of claimed.seqs) await this.eventLog.notify(conv, seq);
        for (const p of claimed.prefixes) await this.deletePrefix(actor.orgId, p);
        return this.applyOrgVersion(actor, pkg);
      }
      // no longer the maintainer's (or the agent got an own skill of the name): register below
    }
    const prefix = skillFilesPrefix(randomUUID());
    let committed: { outcome: RegisterOutcome; toSeq: number | null; superseded: string[] };
    try {
      await this.putFiles(actor.orgId, prefix, pkg.files);
      committed = await this.registerIn(actor, pkg, skillManifest(pkg), prefix, opts.inTransaction);
    } catch (e) {
      await this.deletePrefix(actor.orgId, prefix);
      throw e;
    }
    if (committed.toSeq !== null && actor.conversationId !== undefined) {
      await this.eventLog.notify(actor.conversationId, committed.toSeq);
    }
    for (const p of committed.superseded) await this.deletePrefix(actor.orgId, p);
    return committed.outcome;
  }

  /**
   * Shares one of the agent's own skills with the org (only the agent's current owner; the
   * deployment's `customSkills` must allow it, else 403 `catalog.custom_disabled`). The org may
   * not already have a skill of that name (409 `skill.name_exists`).
   * - An org admin owner: in one transaction the skill becomes an org skill (`scope = org`,
   *   `agent_id` cleared, `origin_agent_id` = the agent, `maintainer_account_id` = the actor);
   *   audit `skill.shared`. Its id, versions and files stay, and the agent keeps resolving it.
   * - Anyone else: a share request for the org admins (`kind = 'share'`, the current version, no
   *   new files: its prefix is the version's and never deleted); a pending one -> 409
   *   `skill.share_pending`. Audit `skill.share_requested`.
   */
  async share(actor: AgentSkillActor, skillId: string): Promise<ShareOutcome> {
    await this.assertOwner(actor.orgId, actor.agentId, actor.accountId);
    await assertCustomAllowed(this.db.db, "customSkills");
    const admin = await isOrgAdmin(this.db.db, actor.orgId, actor.accountId);
    return this.shareIn(actor, skillId, admin);
  }

  /**
   * Soft-deletes one of the agent's own skills (only the agent's current owner; others 403
   * `forbidden`): missing / already deleted / not this agent's -> `skill.not_found`. A pending
   * request of the same name is cancelled with it (a version draft: a reverting snapshot in the
   * requesting conversation, its draft deleted after the commit; a share request keeps its
   * files). Audits `skill.deleted`. Every conversation drops it at its next run start; the name
   * can then be registered again as a new skill.
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

  /**
   * Whether the account maintains a live shared org skill and is an org admin, read live: then a
   * registration may apply a version to an org skill at once (the Platform operation's
   * confirmation class is `org` for it, before the package name is known).
   */
  async mayApplyOrgVersions(orgId: string, accountId: string): Promise<boolean> {
    const maintained = await this.db
      .selectFrom("skills")
      .select("id")
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("maintainer_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return maintained !== undefined && (await isOrgAdmin(this.db.db, orgId, accountId));
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

  /**
   * The live shared org skill named `name` that `accountId` maintains, when the agent has no own
   * skill of that name (locked FOR UPDATE when `lock`, after the own skill row was looked at).
   */
  private async maintainedSkill(
    actor: Pick<AgentSkillActor, "orgId" | "agentId" | "accountId">,
    name: string,
    lock: boolean,
  ): Promise<{ id: string; current_version: number } | undefined> {
    let q = this.db
      .selectFrom("skills")
      .select(["id", "current_version"])
      .where("org_id", "=", actor.orgId)
      .where("scope", "=", "org")
      .where("name", "=", name)
      .where("maintainer_account_id", "=", actor.accountId)
      .where("deleted_at", "is", null);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /**
   * Whether registering `name` applies a version to a shared org skill at once: the actor, an org
   * admin, maintains a live org skill of that name and the agent has no own skill of it.
   */
  private async appliesToOrgSkill(actor: AgentSkillActor, name: string): Promise<boolean> {
    const own = await this.db
      .selectFrom("skills")
      .select("id")
      .where("org_id", "=", actor.orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", actor.agentId)
      .where("name", "=", name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (own) return false;
    if ((await this.maintainedSkill(actor, name, false)) === undefined) return false;
    return isOrgAdmin(this.db.db, actor.orgId, actor.accountId);
  }

  /**
   * An org admin maintainer's new version of a shared skill: written as an org skill version
   * (`SkillsService.createVersionFromFiles`, which re-checks `skills.manage` under the org row
   * lock and handles a skill the org promoted), then the registering conversation's catalog gets
   * it at once. {@link claimIn} ran first.
   */
  private async applyOrgVersion(
    actor: AgentSkillActor,
    pkg: SkillPackageInput,
  ): Promise<RegisterOutcome> {
    const out = await this.skills.createVersionFromFiles(actor.orgId, actor.accountId, pkg, {
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      auditDetail: {
        agentId: actor.agentId,
        ...(actor.conversationId !== undefined && { conversationId: actor.conversationId }),
        ...actor.auditDetail,
      },
    });
    const forModel = invocationOf(skillManifest(pkg)).model;
    if (actor.conversationId !== undefined) {
      const toSeq = await this.appendAppliedIn(actor, actor.conversationId, out, pkg, forModel);
      if (toSeq !== null) await this.eventLog.notify(actor.conversationId, toSeq);
    }
    return {
      kind: "version",
      skillId: out.skill.id,
      name: pkg.name,
      version: out.version,
      created: out.created,
      manualOnly: !forModel,
    };
  }

  /**
   * Before {@link applyOrgVersion} writes the version, in a transaction of its own: re-checks the
   * owner (agent row lock) and that the actor still maintains the org skill of that name with no
   * own skill of it (skill row lock); cancels the skill's pending version proposals (an older one
   * must not overwrite this version later: reverting snapshots, drafts deleted after the commit)
   * and runs `inTransaction` (consuming the upload). Returns null, cancelling and consuming
   * nothing, when the skill no longer qualifies or a proposal appeared in a conversation that was
   * not locked first (the caller registers it the ordinary way).
   * Lock order org -> agent -> the proposals' conversations -> skill row -> request rows.
   */
  @Transactional()
  private async claimIn(
    actor: AgentSkillActor,
    name: string,
    inTransaction: (() => Promise<void>) | undefined,
  ): Promise<CancelledDrafts | null> {
    await keyShareOrg(this.db, actor.orgId);
    await this.checkOwner(actor.orgId, actor.agentId, actor.accountId, true);
    const seen = await this.maintainedSkill(actor, name, false);
    if (seen === undefined) return null;
    const proposals = (skillId: string) =>
      this.db
        .selectFrom("skill_change_requests")
        .selectAll()
        .where("skill_id", "=", skillId)
        .where("kind", "=", "version")
        .where("status", "=", "pending");
    const convs = [
      ...new Set(
        (await proposals(seen.id).execute()).flatMap((r) =>
          r.requested_in_conversation === null ? [] : [r.requested_in_conversation],
        ),
      ),
    ].sort();
    if (convs.length > 0) {
      await this.db
        .selectFrom("conversations")
        .select("id")
        .where("id", "in", convs)
        .orderBy("id")
        .forUpdate()
        .execute();
    }
    const own = await this.db
      .selectFrom("skills")
      .select("id")
      .where("org_id", "=", actor.orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", actor.agentId)
      .where("name", "=", name)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    const shared = own ? undefined : await this.maintainedSkill(actor, name, true);
    if (shared === undefined) return null;
    const pending = await proposals(shared.id).orderBy("created_at").forUpdate().execute();
    // A proposal committed after the conversations were locked: its revert would lock a
    // conversation after the skill row (reverse order). Back off to the ordinary register path
    const locked = new Set(convs);
    if (
      pending.some(
        (r) => r.requested_in_conversation !== null && !locked.has(r.requested_in_conversation),
      )
    ) {
      return null;
    }
    const out: CancelledDrafts = { prefixes: [], seqs: [] };
    for (const r of pending) {
      await cancelRequestIn(this.catalogDeps, r, out, {
        actorAccountId: actor.accountId,
        ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
        reason: "superseded",
      });
    }
    if (inTransaction !== undefined) await inTransaction();
    return out;
  }

  /**
   * After {@link applyOrgVersion}: appends a snapshot to the conversation (of this org and agent)
   * with the org skill's new version. A version served from the platform row (a skill the org
   * promoted) has no version row of the org: nothing is appended, the next run start resolves it.
   */
  @Transactional()
  private async appendAppliedIn(
    actor: AgentSkillActor,
    conversationId: string,
    out: { skill: { id: string }; version: number },
    pkg: SkillPackageInput,
    forModel: boolean,
  ): Promise<number | null> {
    await keyShareOrg(this.db, actor.orgId);
    await this.lockConversation(actor, conversationId);
    const v = await this.db
      .selectFrom("skill_versions")
      .select("object_prefix")
      .where("skill_id", "=", out.skill.id)
      .where("version", "=", out.version)
      .executeTakeFirst();
    if (!v) return null;
    return appendConversationCatalog(
      this.catalogDeps,
      conversationId,
      (base) =>
        withVersion(base, {
          skillId: out.skill.id,
          name: pkg.name,
          description: pkg.description,
          version: out.version,
          source: v.object_prefix,
          forModel,
        }),
      `skills_catalog:register:${v.object_prefix}`,
      actor.runId,
    );
  }

  /**
   * Locks the conversation row (the snapshot append's lock): a conversation of this org with this
   * agent only (defense in depth: callers pass the run's own), else `conversation.not_found`.
   */
  private async lockConversation(actor: AgentSkillActor, conversationId: string): Promise<void> {
    const conv = await this.db
      .selectFrom("conversations")
      .select("agent_id")
      .where("id", "=", conversationId)
      .where("org_id", "=", actor.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (conv?.agent_id !== actor.agentId) {
      throw new ApiError("conversation.not_found", "Conversation not found");
    }
  }

  /** The transaction of {@link register}. */
  @Transactional()
  private async registerIn(
    actor: AgentSkillActor,
    pkg: { name: string; description: string; files: SkillPackageFile[] },
    manifest: SkillManifest,
    prefix: string,
    inTransaction: (() => Promise<void>) | undefined,
  ): Promise<{ outcome: RegisterOutcome; toSeq: number | null; superseded: string[] }> {
    await keyShareOrg(this.db, actor.orgId);
    await this.checkOwner(actor.orgId, actor.agentId, actor.accountId, true);
    // Then the conversation row, still after the agent row
    if (actor.conversationId !== undefined)
      await this.lockConversation(actor, actor.conversationId);
    if (inTransaction !== undefined) await inTransaction();
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
    const superseded: CancelledDrafts = { prefixes: [], seqs: [] };
    if (!existing) {
      const shared = await this.maintainedSkill(actor, pkg.name, true);
      if (shared) return this.proposeIn(actor, pkg, manifest, prefix, shared);
      await this.assertNoUsedOrgSkillNamed(actor, pkg.name);
      await assertBelowAgentSkillCap(this.db, actor.agentId);
    } else {
      // A pending share was for the version the admins review: a new version supersedes it (the
      // share's files are that version's own and stay)
      const shares = await this.db
        .selectFrom("skill_change_requests")
        .selectAll()
        .where("skill_id", "=", existing.id)
        .where("kind", "=", "share")
        .where("status", "=", "pending")
        .forUpdate()
        .execute();
      for (const r of shares) {
        await cancelRequestIn(this.catalogDeps, r, superseded, {
          actorAccountId: actor.accountId,
          ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
          reason: "superseded_by_new_version",
        });
      }
    }
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
      // snapshot (source = this version's prefix)
      toSeq = await appendConversationCatalog(
        this.catalogDeps,
        actor.conversationId,
        (base) =>
          withVersion(base, {
            skillId,
            name: pkg.name,
            description: pkg.description,
            version,
            source: prefix,
            forModel,
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
      superseded: superseded.prefixes,
    };
  }

  /**
   * Spec §5.2: an agent's own skill may not take the name of an org skill the agent uses (one it
   * has on: every org skill its current definition does not turn off, skills default-on spec §3,
   * and the ones it shared) unless the actor maintains it (then the registration is a version of
   * it): 409 `skill.name_exists`.
   */
  private async assertNoUsedOrgSkillNamed(actor: AgentSkillActor, name: string): Promise<void> {
    const def = await this.db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select("agent_versions.definition")
      .where("agents.id", "=", actor.agentId)
      .executeTakeFirst();
    const disabledSkills =
      def === undefined ? [] : (normalizeStoredDefinition(def.definition).disabledSkills ?? []);
    const used = (
      await agentSkills(this.db.db, {
        orgId: actor.orgId,
        agentId: actor.agentId,
        disabledSkills,
      })
    ).find(
      (r) =>
        r.scope === "org" &&
        r.name === name &&
        // an org skill, or the org's copy linked to a platform skill (listed under the copy's id);
        // a platform skill itself is not the org's to clash with
        (r.origin === "org" || (r.platformSkillId !== undefined && r.id !== r.platformSkillId)),
    );
    if (used) {
      throw new ApiError(
        "skill.name_exists",
        `This agent uses the org skill "${name}", which only its maintainer can update; register the package under another name, or ask the skill's maintainer.`,
      );
    }
  }

  /**
   * In {@link registerIn} (the org skill row locked): a version proposal on the shared skill. The
   * pending proposals of that skill (and any pending request of this agent with the name) are
   * locked: one from another conversation refuses, ones from this conversation are superseded.
   * The trial applies only in the proposing conversation (the catalog overlay reads pending
   * `version` requests by conversation).
   */
  private async proposeIn(
    actor: AgentSkillActor,
    pkg: { name: string; description: string; files: SkillPackageFile[] },
    manifest: SkillManifest,
    prefix: string,
    shared: { id: string; current_version: number },
  ): Promise<{ outcome: RegisterOutcome; toSeq: number | null; superseded: string[] }> {
    // A shared skill is an org skill: refused while custom org skills are denied
    await assertCustomAllowed(this.db.db, "customSkills");
    const here = actor.conversationId ?? null;
    const pending = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("org_id", "=", actor.orgId)
      .where("status", "=", "pending")
      .where((eb) =>
        eb.or([
          eb.and([eb("skill_id", "=", shared.id), eb("kind", "=", "version")]),
          eb.and([
            eb("agent_id", "=", actor.agentId),
            eb(sql<string>`proposed_version -> 'manifest' ->> 'name'`, "=", pkg.name),
          ]),
        ]),
      )
      .orderBy("created_at")
      .forUpdate()
      .execute();
    if (
      pending.some(
        (p) =>
          p.kind !== "version" ||
          p.agent_id !== actor.agentId ||
          p.requested_in_conversation !== here,
      )
    ) {
      throw new ApiError(
        "skill.proposal_pending_elsewhere",
        `A proposed version of the skill "${pkg.name}" from another conversation is waiting for an org admin; wait for that decision, or continue in that conversation.`,
      );
    }
    const superseded: CancelledDrafts = { prefixes: [], seqs: [] };
    for (const p of pending) {
      await cancelRequestIn(this.catalogDeps, p, superseded, {
        actorAccountId: actor.accountId,
        ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
        reason: "superseded",
        // the new snapshot below replaces the draft: no reverting snapshot in between
        revert: false,
      });
    }
    const version = shared.current_version + 1;
    const requestId = randomUUID();
    await this.db
      .insertInto("skill_change_requests")
      .values({
        id: requestId,
        org_id: actor.orgId,
        agent_id: actor.agentId,
        skill_id: shared.id,
        kind: "version",
        proposed_version: JSON.stringify({ skillId: shared.id, version, manifest }),
        object_prefix: prefix,
        requested_by_account: actor.accountId,
        requested_in_conversation: here,
      })
      .execute();
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      orgId: actor.orgId,
      action: "skill.change_requested",
      target: requestId,
      detail: {
        kind: "version",
        skillId: shared.id,
        name: pkg.name,
        version,
        files: manifest.files.length,
        agentId: actor.agentId,
        ...(here !== null && { conversationId: here }),
        ...actor.auditDetail,
      },
    });
    const forModel = invocationOf(manifest).model;
    let toSeq: number | null = null;
    if (actor.conversationId !== undefined) {
      toSeq = await appendConversationCatalog(
        this.catalogDeps,
        actor.conversationId,
        (base) =>
          withVersion(base, {
            skillId: shared.id,
            name: pkg.name,
            description: pkg.description,
            version,
            source: prefix,
            forModel,
          }),
        `skills_catalog:propose:${prefix}`,
        actor.runId,
      );
    }
    return {
      outcome: {
        kind: "proposed",
        requestId,
        skillId: shared.id,
        name: pkg.name,
        version,
        manualOnly: !forModel,
      },
      toSeq,
      superseded: superseded.prefixes,
    };
  }

  /** The transaction of {@link share} (lock order org -> agent -> skill row -> request rows). */
  @Transactional()
  private async shareIn(
    actor: AgentSkillActor,
    skillId: string,
    admin: boolean,
  ): Promise<ShareOutcome> {
    // An org admin changes the org's skill library: the org row lock re-checks the role live and
    // serializes it with every other org skill write (names stay unique)
    if (admin) await this.orgLock.lockAndAuthorize(actor.orgId, actor.accountId, "skills.manage");
    else await keyShareOrg(this.db, actor.orgId);
    await this.checkOwner(actor.orgId, actor.agentId, actor.accountId, true);
    await assertCustomAllowed(this.db.db, "customSkills");
    const skill = await this.db
      .selectFrom("skills")
      .select(["id", "name", "current_version"])
      .where("id", "=", skillId)
      .where("org_id", "=", actor.orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", actor.agentId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!skill) throw skillNotFound();
    await assertShareableName(this.db, actor.orgId, skill.name);
    const who = {
      actorAccountId: actor.accountId,
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      orgId: actor.orgId,
    };
    if (admin) {
      await shareSkillIn(this.db, {
        skillId,
        agentId: actor.agentId,
        maintainerAccountId: actor.accountId,
      });
      await audit(this.db.db, {
        ...who,
        action: "skill.shared",
        target: skillId,
        detail: {
          name: skill.name,
          agentId: actor.agentId,
          maintainer: actor.accountId,
          ...actor.auditDetail,
        },
      });
      return { kind: "shared", skillId };
    }
    const pending = await this.db
      .selectFrom("skill_change_requests")
      .select("id")
      .where("skill_id", "=", skillId)
      .where("kind", "=", "share")
      .where("status", "=", "pending")
      .forUpdate()
      .executeTakeFirst();
    if (pending) {
      throw new ApiError(
        "skill.share_pending",
        `Sharing the skill "${skill.name}" is already waiting for an org admin.`,
      );
    }
    const v = await this.db
      .selectFrom("skill_versions")
      .select(["manifest", "object_prefix"])
      .where("skill_id", "=", skillId)
      .where("version", "=", skill.current_version)
      .executeTakeFirstOrThrow();
    const requestId = randomUUID();
    await this.db
      .insertInto("skill_change_requests")
      .values({
        id: requestId,
        org_id: actor.orgId,
        agent_id: actor.agentId,
        skill_id: skillId,
        kind: "share",
        proposed_version: JSON.stringify({
          skillId,
          version: skill.current_version,
          manifest: v.manifest,
        }),
        // the version's own files: never deleted with the request
        object_prefix: v.object_prefix,
        requested_by_account: actor.accountId,
        requested_in_conversation: null,
      })
      .execute();
    await audit(this.db.db, {
      ...who,
      action: "skill.share_requested",
      target: skillId,
      detail: {
        requestId,
        name: skill.name,
        version: skill.current_version,
        agentId: actor.agentId,
        ...actor.auditDetail,
      },
    });
    return { kind: "requested", requestId };
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
    if (!r) throw skillNotFound();
    const out: CancelledDrafts = { prefixes: [], seqs: [] };
    const pend = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("status", "=", "pending")
      .where(sql<string>`proposed_version -> 'manifest' ->> 'name'`, "=", r.name)
      .forUpdate()
      .execute();
    for (const p of pend) {
      await cancelRequestIn(this.catalogDeps, p, out, {
        actorAccountId: accountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        reason: "skill_deleted",
      });
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
