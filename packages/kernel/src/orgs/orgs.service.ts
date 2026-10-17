import { randomBytes, randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type { KernelDatabase, KernelDb, OrgsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { Account } from "../identity/accounts.js";
import type { ApiTokenService } from "../identity/api-tokens.js";
import { audit } from "../identity/audit.js";
import type { SettingsService } from "../identity/settings.js";
import { can, type OrgAction, type OrgRole } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

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

/** 组织服务：创建、查询、修改与软删除。框架无关，由调用方注入依赖。 */
export class OrgsService {
  constructor(
    private readonly db: KernelDb,
    private readonly settings: SettingsService,
    private readonly apiTokens: ApiTokenService,
  ) {}

  /**
   * 建组织，创建者为 owner。传入 `trx` 时在调用方的事务内执行（初始化向导与建账号同一事务）；
   * 此时 slug 冲突同样转成 `org.slug_taken`，但该事务已中止，调用方只能回滚。
   */
  async create(
    input: { name: string; slug?: string | undefined },
    actor: Account,
    trx?: Trx,
  ): Promise<Org> {
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
    const run = async (t: Trx): Promise<Org> => {
      const row = await t
        .insertInto("orgs")
        .values({ id: randomUUID(), slug, name, created_by: actor.id })
        .returning(["id", "slug", "name", "created_at"])
        .executeTakeFirstOrThrow();
      await t
        .insertInto("memberships")
        .values({ org_id: row.id, account_id: actor.id, role: "owner" })
        .execute();
      await audit(t, {
        actorAccountId: actor.id,
        orgId: row.id,
        action: "org.created",
        target: row.id,
        detail: { slug, name },
      });
      return toOrg(row);
    };
    return slugGuard(trx ? run(trx) : this.db.transaction().execute(run));
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

  /** 改名 / slug（需 admin，锁内实时判定）。 */
  async update(
    orgId: string,
    patch: { name?: string | undefined; slug?: string | undefined },
    actor: Account,
  ): Promise<Org> {
    const values: { name?: string; slug?: string } = {};
    if (patch.name !== undefined) values.name = checkName(patch.name);
    if (patch.slug !== undefined) {
      checkSlug(patch.slug);
      values.slug = patch.slug;
    }
    return slugGuard(
      this.db.transaction().execute(async (trx) => {
        const before = await this.lockAndAuthorize(trx, orgId, actor.id, "org.update");
        if (Object.keys(values).length === 0) {
          const row = await trx
            .selectFrom("orgs")
            .select(["id", "slug", "name", "created_at"])
            .where("id", "=", orgId)
            .executeTakeFirstOrThrow();
          return toOrg(row);
        }
        const row = await trx
          .updateTable("orgs")
          .set(values)
          .where("id", "=", orgId)
          .returning(["id", "slug", "name", "created_at"])
          .executeTakeFirstOrThrow();
        await audit(trx, {
          actorAccountId: actor.id,
          orgId,
          action: "org.updated",
          target: orgId,
          detail: { before, after: values },
        });
        return toOrg(row);
      }),
    );
  }

  /**
   * 锁住组织行（与成员变更串行化），并在锁内实时重读发起人的角色（spec 3.6 R5）：
   * 组织不存在或已软删除 → `org.not_found`；发起人不是成员或角色不足 → `forbidden`。
   */
  private async lockAndAuthorize(
    trx: Trx,
    orgId: string,
    actorAccountId: string,
    action: OrgAction,
  ): Promise<{ slug: string; name: string }> {
    const org = await trx
      .selectFrom("orgs")
      .select(["slug", "name"])
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!org) throw new ApiError("org.not_found", "Organization not found");
    const m = await trx
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", actorAccountId)
      .executeTakeFirst();
    if (!m || !can(m.role, action)) {
      throw new ApiError("forbidden", "Insufficient organization role");
    }
    return org;
  }

  /** 软删除（需 owner，锁内实时判定）：同一事务吊销该组织的服务令牌、清空指向它的会话当前组织。 */
  async softDelete(orgId: string, actor: Account): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lockAndAuthorize(trx, orgId, actor.id, "org.delete");
      await trx
        .updateTable("orgs")
        .set({ deleted_at: sql<Date>`now()` })
        .where("id", "=", orgId)
        .execute();
      await this.apiTokens.revokeAllForOrg(orgId, trx);
      await trx
        .updateTable("sessions")
        .set({ current_org_id: null })
        .where("current_org_id", "=", orgId)
        .execute();
      await audit(trx, {
        actorAccountId: actor.id,
        orgId,
        action: "org.deleted",
        target: orgId,
      });
    });
  }
}
