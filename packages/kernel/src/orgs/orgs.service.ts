import { randomBytes, randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type { KernelDatabase, KernelDb, OrgsTable } from "../db/kernel-schema.js";
import { cancelPendingRequests } from "../directory/requests.service.js";
import { ApiError } from "../errors.js";
import { cancelEvalRuns } from "../evals/budget.js";
import type { Account } from "../identity/accounts.js";
import type { ApiTokenService } from "../identity/api-tokens.js";
import { audit } from "../identity/audit.js";
import type { SettingsService } from "../identity/settings.js";
import { lockOrgAndAuthorize } from "./org-lock.js";
import type { OrgRole } from "./roles.js";

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
    private readonly hooks: {
      /** 软删除提交之后（内核传：给该组织的渠道连接广播 `channel.changed`，长连接立即断开）。 */
      afterDelete?: (orgId: string) => Promise<void>;
    } = {},
  ) {}

  /**
   * 建组织，创建者为 owner。传入 `opts.trx` 时在调用方的事务内执行（初始化向导与建账号同一事务）；
   * 此时 slug 冲突同样转成 `org.slug_taken`，但该事务已中止，调用方只能回滚。
   */
  async create(
    input: { name: string; slug?: string | undefined },
    actor: Account,
    opts: { trx?: Trx | undefined; actorTokenId?: string | undefined } = {},
  ): Promise<Org> {
    const { trx, actorTokenId } = opts;
    // 在调用方事务内读设置：调用方已占着一个连接时再向池要第二个，并发下可能把池耗尽
    const { orgCreation } = await this.settings.get(trx);
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
        ...(actorTokenId !== undefined && { actorTokenId }),
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
    actorTokenId?: string,
  ): Promise<Org> {
    const values: { name?: string; slug?: string } = {};
    if (patch.name !== undefined) values.name = checkName(patch.name);
    if (patch.slug !== undefined) {
      checkSlug(patch.slug);
      values.slug = patch.slug;
    }
    return slugGuard(
      this.db.transaction().execute(async (trx) => {
        const { org: before } = await lockOrgAndAuthorize(trx, orgId, actor.id, "org.update");
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
          ...(actorTokenId !== undefined && { actorTokenId }),
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
   * 软删除（需 owner，锁内实时判定）：同一事务吊销该组织的服务令牌、取消在执行的评测运行与挂着的目录申请、清空指向它的
   * 会话当前组织；
   * 提交后调用 `afterDelete`（渠道连接随组织失效：运行时读连接行时 join 组织过滤已删除的）。
   */
  async softDelete(orgId: string, actor: Account, actorTokenId?: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor.id, "org.delete");
      await trx
        .updateTable("orgs")
        .set({ deleted_at: sql<Date>`now()` })
        .where("id", "=", orgId)
        .execute();
      await this.apiTokens.revokeAllForOrg(orgId, trx);
      // 组织删除后评测运行不再花钱：显式取消（审计带原因）
      await cancelEvalRuns(
        trx,
        { orgId },
        { accountId: actor.id, ...(actorTokenId !== undefined && { tokenId: actorTokenId }) },
        "org_deleted",
      );
      // 挂着的目录申请（含已交企业管理员的）一并取消
      await cancelPendingRequests(
        trx,
        { orgId },
        actor.id,
        "org_deleted",
        actorTokenId !== undefined ? { actorTokenId } : {},
      );
      await trx
        .updateTable("sessions")
        .set({ current_org_id: null })
        .where("current_org_id", "=", orgId)
        .execute();
      await audit(trx, {
        actorAccountId: actor.id,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "org.deleted",
        target: orgId,
      });
    });
    await this.hooks.afterDelete?.(orgId);
  }
}
