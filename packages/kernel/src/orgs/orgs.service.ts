import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import { cancelPendingRequests } from "../catalog/requests.service.js";
import type { OrgsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { cancelEvalRuns } from "../evals/budget.js";
import type { Account } from "../identity/accounts.js";
import { ApiTokenService } from "../identity/api-tokens.js";
import { audit } from "../identity/audit.js";
import { SettingsService } from "../identity/settings.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { OrgLock } from "./org-lock.js";
import type { OrgRole } from "./roles.js";

export type Org = { id: string; slug: string; name: string; createdAt: Date };

/** 组织 slug：小写字母数字与 `-`，首尾不能是 `-`，1–40 个字符。 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_SLUG = 40;
const MAX_NAME = 100;

function toOrg(r: Pick<Selectable<OrgsTable>, "id" | "slug" | "name" | "created_at">): Org {
  return { id: r.id, slug: r.slug, name: r.name, createdAt: r.created_at };
}

/** 由名字生成 slug：转小写、非字母数字换 `-`、去首尾 `-`；为空则 `org-<6 位随机>`。 */
export function slugFromName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, "");
  if (s) return s;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join("");
  return `org-${rand}`;
}

function checkSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ApiError(
      "validation_failed",
      "Slug must be 1-40 lowercase letters, digits or '-', not starting or ending with '-'",
    );
  }
}

function checkName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > MAX_NAME) {
    throw new ApiError("validation_failed", `Organization name must be 1-${MAX_NAME} characters`);
  }
  return n;
}

/** 仅当违反「存活组织 slug 唯一」索引时为 true。 */
function isSlugTaken(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string };
  return err.code === "23505" && err.constraint === "orgs_slug_live_uq";
}

async function slugGuard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isSlugTaken(e)) throw new ApiError("org.slug_taken", "Slug is already taken");
    throw e;
  }
}

/**
 * Organizations: create, read, update and soft delete. A soft delete emits `org.deleted` on
 * {@link KernelEvents} after the commit.
 */
@Injectable()
export class OrgsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ApiTokenService) private readonly apiTokens: ApiTokenService,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(KernelEvents) private readonly events: KernelEvents,
  ) {}

  /**
   * Creates an org with the actor as owner, in the caller's transaction when there is one (the
   * setup wizard creates it with the account); a slug conflict is `org.slug_taken` either way, but
   * a caller's transaction is then aborted and can only roll back.
   */
  async create(
    input: { name: string; slug?: string | undefined },
    actor: Account,
    opts: { actorTokenId?: string | undefined } = {},
  ): Promise<Org> {
    return slugGuard(this.createIn(input, actor, opts.actorTokenId));
  }

  @Transactional()
  private async createIn(
    input: { name: string; slug?: string | undefined },
    actor: Account,
    actorTokenId: string | undefined,
  ): Promise<Org> {
    // read in the context's transaction: a caller holding a connection asking the pool for a
    // second one could exhaust it under load
    const { orgCreation } = await this.settings.get();
    if (orgCreation === "enterprise_admin" && !actor.isEnterpriseAdmin) {
      throw new ApiError(
        "org.creation_disabled",
        "Only enterprise admins can create organizations",
      );
    }
    const name = checkName(input.name);
    const slug = input.slug ?? slugFromName(name);
    checkSlug(slug);
    const row = await this.db
      .insertInto("orgs")
      .values({ id: randomUUID(), slug, name, created_by: actor.id })
      .returning(["id", "slug", "name", "created_at"])
      .executeTakeFirstOrThrow();
    await this.db
      .insertInto("memberships")
      .values({ org_id: row.id, account_id: actor.id, role: "owner" })
      .execute();
    await audit(this.db.db, {
      actorAccountId: actor.id,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId: row.id,
      action: "org.created",
      target: row.id,
      detail: { slug, name },
    });
    return toOrg(row);
  }

  /** 账号所属的（未软删除的）组织及其角色，按创建时间升序。 */
  async listForAccount(accountId: string): Promise<(Org & { role: OrgRole })[]> {
    const rows = await this.db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .select(["orgs.id", "orgs.slug", "orgs.name", "orgs.created_at", "memberships.role"])
      .where("memberships.account_id", "=", accountId)
      .where("orgs.deleted_at", "is", null)
      .orderBy("orgs.created_at")
      .orderBy("orgs.id")
      .execute();
    return rows.map((r) => ({ ...toOrg(r), role: r.role }));
  }

  /** 全部（未软删除的）组织及成员数（企业管理员用）。 */
  async listAll(): Promise<(Org & { memberCount: number })[]> {
    const rows = await this.db
      .selectFrom("orgs")
      .leftJoin("memberships", "memberships.org_id", "orgs.id")
      .select(["orgs.id", "orgs.slug", "orgs.name", "orgs.created_at"])
      .select((eb) => eb.fn.count<string>("memberships.account_id").as("member_count"))
      .where("orgs.deleted_at", "is", null)
      .groupBy(["orgs.id", "orgs.slug", "orgs.name", "orgs.created_at"])
      .orderBy("orgs.created_at")
      .orderBy("orgs.id")
      .execute();
    return rows.map((r) => ({ ...toOrg(r), memberCount: Number(r.member_count) }));
  }

  /** 未软删除的组织；不存在或已软删除为 undefined。 */
  async get(orgId: string): Promise<Org | undefined> {
    const row = await this.db
      .selectFrom("orgs")
      .select(["id", "slug", "name", "created_at"])
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row && toOrg(row);
  }

  /** Renames / re-slugs (needs admin, decided live under the org lock). */
  async update(
    orgId: string,
    patch: { name?: string | undefined; slug?: string | undefined },
    actor: Account,
    actorTokenId?: string,
  ): Promise<Org> {
    const values: { name?: string; slug?: string } = {};
    if (patch.name !== undefined) values.name = checkName(patch.name);
    if (patch.slug !== undefined) {
      checkSlug(patch.slug);
      values.slug = patch.slug;
    }
    return slugGuard(this.updateIn(orgId, values, actor, actorTokenId));
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    values: { name?: string; slug?: string },
    actor: Account,
    actorTokenId: string | undefined,
  ): Promise<Org> {
    const { org: before } = await this.orgLock.lockAndAuthorize(orgId, actor.id, "org.update");
    if (Object.keys(values).length === 0) {
      const row = await this.db
        .selectFrom("orgs")
        .select(["id", "slug", "name", "created_at"])
        .where("id", "=", orgId)
        .executeTakeFirstOrThrow();
      return toOrg(row);
    }
    const row = await this.db
      .updateTable("orgs")
      .set(values)
      .where("id", "=", orgId)
      .returning(["id", "slug", "name", "created_at"])
      .executeTakeFirstOrThrow();
    await audit(this.db.db, {
      actorAccountId: actor.id,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "org.updated",
      target: orgId,
      detail: { before, after: values },
    });
    return toOrg(row);
  }

  /**
   * Soft delete (needs owner, decided live under the org lock): in the same transaction revokes
   * the org's service tokens, cancels its running eval runs and pending catalog requests, and
   * clears sessions' current org pointing at it; after the commit emits `org.deleted` (channel
   * connections go with the org: the runtime's connection reads filter deleted orgs).
   */
  async softDelete(orgId: string, actor: Account, actorTokenId?: string): Promise<void> {
    await this.softDeleteIn(orgId, actor, actorTokenId);
  }

  @Transactional()
  private async softDeleteIn(
    orgId: string,
    actor: Account,
    actorTokenId: string | undefined,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actor.id, "org.delete");
    await this.db
      .updateTable("orgs")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", orgId)
      .execute();
    await this.apiTokens.revokeAllForOrg(orgId);
    // eval runs of a deleted org stop spending: cancelled explicitly (audited with the reason)
    await cancelEvalRuns(
      this.db.db,
      { orgId },
      { accountId: actor.id, ...(actorTokenId !== undefined && { tokenId: actorTokenId }) },
      "org_deleted",
    );
    // pending catalog requests (including those passed to enterprise admins) are cancelled too
    await cancelPendingRequests(
      this.db.db,
      { orgId },
      actor.id,
      "org_deleted",
      actorTokenId !== undefined ? { actorTokenId } : {},
    );
    await this.db
      .updateTable("sessions")
      .set({ current_org_id: null })
      .where("current_org_id", "=", orgId)
      .execute();
    await audit(this.db.db, {
      actorAccountId: actor.id,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "org.deleted",
      target: orgId,
    });
    // channel connections follow the org after the root commit (none after a rollback)
    afterCommit(() => this.events.emit("org.deleted", { orgId }));
  }
}
