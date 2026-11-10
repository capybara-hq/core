import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import type { OwnerVersion } from "../catalog/platform-components.js";
import { EventLog } from "../conversations/event-log.js";
import type { SkillChangeRequestsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { assertCustomAllowed } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { StorageService } from "../storage/storage.service.js";
import { assertShareableName, isOrgAdmin, shareSkillIn } from "./agent-skills.service.js";
import {
  type CancelledDrafts,
  type ConversationCatalogDeps,
  cancelRequestIn,
  revertTrialCatalog,
} from "./conversation-catalog.js";
import type { SkillPackageInput } from "./package.js";
import { SkillsService } from "./skills.service.js";

export type { CancelledDrafts } from "./conversation-catalog.js";

/** The cap on file contents read for a detail (drafts are <= 1 MB; with headroom). */
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
/** The most skill changes one inbox read returns. */
export const SKILL_CHANGES_LIST_MAX = 100;

export type SkillChangeStatus = "pending" | "approved" | "rejected" | "cancelled";

/** A request kind: sharing an agent skill with the org, or a new version of a shared skill. */
export type SkillChangeKind = "share" | "version";

/** One skill change request (list / inbox). */
export interface SkillChangeView {
  id: string;
  orgId: string;
  kind: SkillChangeKind;
  agent: { id: string; name: string };
  /** A share: the agent skill; a version proposal: the shared org skill. */
  skillId: string | null;
  name: string;
  description: string;
  /** A share: the version shared; a version proposal: the version it would become. */
  version: number;
  files: { path: string; size: number }[];
  status: SkillChangeStatus;
  requestedBy: string;
  /** The requester's display name (empty when the account no longer exists). */
  requestedByName: string;
  /** The proposing conversation (null for a share request and a proposal made on the web). */
  requestedInConversation: string | null;
  /** The proposing conversation's web path (no locale prefix), or null. */
  conversationPath: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** One file of a detail: its text, or null when it cannot be read (deleted, over the read cap). */
export interface SkillChangeFile {
  path: string;
  size: number;
  content: string | null;
}

/**
 * The detail: each file with its text (null when the draft is deleted); `current` is the version
 * in effect when the request changes an existing skill (the web shows the difference), null for a
 * share (the shared version is the current one) or when the skill is deleted.
 */
export interface SkillChangeDetail extends Omit<SkillChangeView, "files"> {
  files: SkillChangeFile[];
  current: { version: number; files: SkillChangeFile[] } | null;
}

const iso = (v: Date | string): string => new Date(v).toISOString();
const notFound = () => new ApiError("skill_change.not_found", "Skill change not found");
const forbidden = () => new ApiError("forbidden", "Insufficient organization role");

/**
 * Skill change requests decided by org admins (spec §5.4, §5.5): an agent's owner asks to share
 * one of its skills with the org (`kind = 'share'`, created by `AgentSkillsService.share`), and
 * the maintainer of a shared skill proposes a new version of it (`kind = 'version'`, created by
 * `AgentSkillsService.register`).
 * - `decide` (HTTP, human only; org admins, role read live under the org row lock): approving a
 *   share makes the skill an org skill with the requester as maintainer; approving a version
 *   writes it as the org skill's next version (`SkillsService.createVersionFromFiles`, the draft
 *   prefix becomes the version's) so every agent using it gets it at its next run start;
 *   rejecting a version deletes its draft and reverts the proposing conversation's trial; a share
 *   keeps its files whatever happens. A request that no longer applies (its agent deleted or
 *   transferred, its skill deleted or already moved) is cancelled instead.
 * State is in PG (the org row lock serializes decisions), files in object storage
 * `kernel/<orgId>/skills/<id>/`; no in-process state.
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
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** An approved version is an org skill version. */
    @Inject(SkillsService) private readonly skills: SkillsService,
  ) {
    this.catalogDeps = { db, log, eventLog };
  }

  /**
   * An org admin decides a request (see the class comment): not an org admin -> 403 `forbidden`;
   * already decided -> 409 `skill_change.already_decided`; not in this org -> 404. Approving
   * re-checks `customSkills` (403 `catalog.custom_disabled`) and, for a share, the name (409
   * `skill.name_exists`; the request stays pending). A share whose skill has a newer version than
   * the one reviewed is cancelled, never shared. Audit `skill.change_decided` (and
   * `skill.shared`). Of concurrent decisions one wins, the others get `already_decided`.
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
      .selectAll()
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!head) throw notFound();
    // Refused before any file is read; re-checked under the org row lock
    if (!(await isOrgAdmin(this.db.db, orgId, accountId))) throw forbidden();
    // An approved version needs its files as a package (read before the transaction) and, for a
    // skill the org promoted, written as the platform row's next version: no storage writes run
    // inside the transaction
    let pkg: SkillPackageInput | undefined;
    let owner: OwnerVersion | undefined;
    if (body.decision === "approve" && head.kind === "version" && head.status === "pending") {
      await assertCustomAllowed(this.db.db, "customSkills");
      pkg = await this.readDraft(orgId, head);
      owner = await this.skills.prepareStoredVersion(orgId, pkg);
    }
    let done: Awaited<ReturnType<SkillChangesService["decideIn"]>>;
    try {
      done = await this.decideIn(orgId, id, accountId, body, actorTokenId, head, pkg, owner);
    } catch (e) {
      if (owner !== undefined) await this.skills.discardStoredVersion(owner);
      throw e;
    }
    if (owner !== undefined && !done.usedOwner) await this.skills.discardStoredVersion(owner);
    for (const [conv, seq] of done.drafts.seqs) await this.eventLog.notify(conv, seq);
    for (const p of done.drafts.prefixes) await this.deletePrefix(orgId, p);
    const [view] = await this.views([done.updated]);
    if (!view) throw notFound();
    return view;
  }

  /** A version draft's files as a package (as registered), or 503 when one cannot be read. */
  private async readDraft(
    orgId: string,
    req: Selectable<SkillChangeRequestsTable>,
  ): Promise<SkillPackageInput> {
    const store = this.storage.kernel(orgId);
    const m = req.proposed_version.manifest;
    const files: SkillPackageInput["files"] = [];
    for (const f of m.files) {
      const got = await store.get(`${req.object_prefix}${f.path}`);
      if (!got) {
        throw new ApiError(
          "storage.unavailable",
          "The proposed version's files cannot be read; try again later",
        );
      }
      const data = new Uint8Array(await new Response(got.body).arrayBuffer());
      files.push({ path: f.path, size: f.size, sha256: f.sha256, data });
    }
    return {
      name: m.name,
      description: m.description,
      files,
      ...(m.invocation !== undefined && { invocation: m.invocation }),
    };
  }

  /**
   * The transaction of {@link decide}. Lock order: org row (FOR NO KEY UPDATE, role re-checked) -> agent
   * row -> the proposing conversation (a version's revert appends there) -> skill row -> request
   * row, the order registration and sharing use.
   */
  @Transactional()
  private async decideIn(
    orgId: string,
    id: string,
    accountId: string,
    body: { decision: "approve" | "reject"; note?: string | undefined },
    actorTokenId: string | undefined,
    head: Selectable<SkillChangeRequestsTable>,
    pkg: SkillPackageInput | undefined,
    owner: OwnerVersion | undefined,
  ): Promise<{
    updated: Selectable<SkillChangeRequestsTable>;
    drafts: CancelledDrafts;
    /** Whether the prepared platform version became the skill's version. */
    usedOwner: boolean;
  }> {
    await this.orgLock.lockAndAuthorize(orgId, accountId, "skills.manage");
    const agent = await this.db
      .selectFrom("agents")
      .select(["owner_account_id", "deleted_at"])
      .where("id", "=", head.agent_id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (head.kind === "version" && head.requested_in_conversation !== null) {
      await this.db
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", head.requested_in_conversation)
        .forUpdate()
        .executeTakeFirst();
    }
    const skill =
      head.skill_id === null
        ? undefined
        : await this.db
            .selectFrom("skills")
            .select(["id", "scope", "agent_id", "name", "deleted_at", "current_version"])
            .where("id", "=", head.skill_id)
            .forUpdate()
            .executeTakeFirst();
    const req = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    // the row went between the first read and the lock (agent / org hard-deleted) -> 404, not 500
    if (!req) throw notFound();
    if (req.status !== "pending") {
      throw new ApiError(
        "skill_change.already_decided",
        "This skill change has already been decided",
      );
    }
    const drafts: CancelledDrafts = { prefixes: [], seqs: [] };
    // A share applies only to the version the admin reviewed; a version proposal only to the skill
    // of its name
    const applies =
      agent !== undefined &&
      agent.deleted_at === null &&
      skill !== undefined &&
      skill.deleted_at === null &&
      (req.kind === "share"
        ? skill.scope === "agent" &&
          skill.agent_id === req.agent_id &&
          skill.current_version === req.proposed_version.version &&
          agent.owner_account_id === req.requested_by_account
        : skill.scope === "org" && skill.name === req.proposed_version.manifest.name);
    if (!applies) {
      await cancelRequestIn(this.catalogDeps, req, drafts, {
        actorAccountId: accountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        reason: "stale",
      });
      return { updated: await this.reread(id), drafts, usedOwner: false };
    }
    const p = req.proposed_version;
    const approved = body.decision === "approve";
    let version = p.version;
    if (approved && req.kind === "share") {
      await assertCustomAllowed(this.db.db, "customSkills");
      await assertShareableName(this.db, orgId, skill.name);
      await shareSkillIn(this.db, {
        skillId: skill.id,
        agentId: req.agent_id,
        maintainerAccountId: req.requested_by_account,
      });
      await audit(this.db.db, {
        actorAccountId: accountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "skill.shared",
        target: skill.id,
        detail: {
          name: skill.name,
          agentId: req.agent_id,
          maintainer: req.requested_by_account,
          requestId: id,
        },
      });
    } else if (approved) {
      if (pkg === undefined) throw new Error("an approved version needs its files");
      await assertCustomAllowed(this.db.db, "customSkills");
      // Joins this transaction without storage I/O: the version is the org skill's next one, the
      // draft prefix its files; a skill the org promoted gets the platform version prepared before
      const out = await this.skills.createVersionFromFiles(orgId, accountId, pkg, {
        prefix: req.object_prefix,
        stored: owner !== undefined ? { owner } : {},
        ...(actorTokenId !== undefined && { actorTokenId }),
        auditDetail: {
          requestId: id,
          agentId: req.agent_id,
          requestedBy: req.requested_by_account,
        },
      });
      version = out.version;
      const own = await this.db
        .selectFrom("skill_versions")
        .select("object_prefix")
        .where("skill_id", "=", skill.id)
        .where("version", "=", out.version)
        .executeTakeFirst();
      if (own?.object_prefix !== req.object_prefix) {
        // Served from elsewhere (the platform row): the draft is not a version's files
        const seq = await revertTrialCatalog(this.catalogDeps, req);
        if (seq !== null && req.requested_in_conversation !== null) {
          drafts.seqs.push([req.requested_in_conversation, seq]);
        }
        drafts.prefixes.push(req.object_prefix);
      }
    }
    const updated = await this.db
      .updateTable("skill_change_requests")
      .set({
        status: approved ? "approved" : "rejected",
        decided_by: accountId,
        decided_at: sql<Date>`now()`,
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
        kind: req.kind,
        agentId: req.agent_id,
        skillId: skill.id,
        name: p.manifest.name,
        version,
        requestedBy: req.requested_by_account,
        ...(req.requested_in_conversation !== null && {
          conversationId: req.requested_in_conversation,
        }),
        ...(body.note !== undefined && { note: body.note }),
      },
    });
    // A rejected version: the proposing conversation goes back to the current version at once
    // and the draft is deleted; a rejected share changes nothing
    if (!approved && req.kind === "version") {
      const seq = await revertTrialCatalog(this.catalogDeps, req);
      if (seq !== null && req.requested_in_conversation !== null) {
        drafts.seqs.push([req.requested_in_conversation, seq]);
      }
      drafts.prefixes.push(req.object_prefix);
    }
    return {
      updated,
      drafts,
      usedOwner: approved && req.kind === "version" && owner !== undefined,
    };
  }

  private reread(id: string): Promise<Selectable<SkillChangeRequestsTable>> {
    return this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  /**
   * The org's pending requests when the account is an org admin (read live; anyone else gets
   * none), newest first, at most {@link SKILL_CHANGES_LIST_MAX}.
   */
  async listPending(orgId: string, accountId: string): Promise<SkillChangeView[]> {
    if (!(await isOrgAdmin(this.db.db, orgId, accountId))) return [];
    const rows = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .orderBy("created_at", "desc")
      .limit(SKILL_CHANGES_LIST_MAX)
      .execute();
    return this.views(rows);
  }

  /**
   * The detail (with file texts): only org admins and the requester see it, anyone else 404 (the
   * request's existence is not disclosed). A version draft's contents are null once it is deleted
   * (rejected / cancelled); a share's files are the skill version's own and stay readable.
   */
  async get(orgId: string, id: string, accountId: string): Promise<SkillChangeDetail> {
    const row = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw notFound();
    if (
      row.requested_by_account !== accountId &&
      !(await isOrgAdmin(this.db.db, orgId, accountId))
    ) {
      throw notFound();
    }
    const [view] = await this.views([row]);
    if (!view) throw notFound();
    const live = row.kind === "share" || row.status === "pending" || row.status === "approved";
    const store = this.storage.kernel(orgId);
    const budget = { left: DETAIL_MAX_BYTES };
    const files = await readTexts(
      live ? store : undefined,
      row.object_prefix,
      row.proposed_version.manifest.files,
      budget,
    );
    // A change of an existing skill: the version in effect, for the difference
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
      // the request is the current version itself (a share, an approved version): no "before"
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
   * In the caller's transaction (`mandatory`: `AgentsService` holds the org and agent row locks),
   * cancels the agent's pending requests of the given kinds (default both): marks them
   * cancelled, audits, and for version drafts appends a reverting snapshot to each proposing
   * conversation. The agent's delete cancels both kinds; an ownership transfer only shares (the
   * new owner did not ask). After the commit the caller runs {@link finishCancel} to delete the
   * drafts and publish the events.
   */
  @Transactional({ propagation: "mandatory" })
  async cancelPendingForAgent(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    reason: string,
    actorTokenId?: string,
    kinds: readonly SkillChangeKind[] = ["share", "version"],
  ): Promise<CancelledDrafts> {
    const rows = await this.db
      .selectFrom("skill_change_requests")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("agent_id", "=", agentId)
      .where("status", "=", "pending")
      .where("kind", "in", [...kinds])
      .orderBy("created_at")
      .forUpdate()
      .execute();
    const out: CancelledDrafts = { prefixes: [], seqs: [] };
    for (const r of rows) {
      await cancelRequestIn(this.catalogDeps, r, out, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        reason,
      });
    }
    return out;
  }

  /** After {@link cancelPendingForAgent} commits: publishes the events, deletes the drafts. */
  async finishCancel(orgId: string, c: CancelledDrafts): Promise<void> {
    for (const [conv, seq] of c.seqs) await this.eventLog.notify(conv, seq);
    for (const p of c.prefixes) await this.deletePrefix(orgId, p);
  }

  /** Deletes draft objects best effort (a failure is only logged: org data cleanup removes them). */
  private async deletePrefix(orgId: string, prefix: string): Promise<void> {
    try {
      await this.storage.kernel(orgId).deletePrefix(prefix);
    } catch (err) {
      this.log.warn("skill draft cleanup failed", { orgId, prefix, err });
    }
  }

  /** Adds the agent names and requester names. */
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
      kind: r.kind,
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
      conversationPath:
        r.requested_in_conversation === null ? null : `/chat/${r.requested_in_conversation}`,
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
