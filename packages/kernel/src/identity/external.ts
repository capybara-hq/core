import { randomUUID } from "node:crypto";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelSchemaDb, LinkedVia } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";

type Trx = Transaction<KernelDatabase>;

/** `<插件名>:<租户 id>`；插件名同清单规则，租户 id 为非空、不含空白的串。 */
const SOURCE_RE = /^([a-z0-9][a-z0-9._-]{0,213}):(\S{1,256})$/;
const MAX_EXTERNAL_ID = 256;
const MAX_DISPLAY_NAME = 200;
const MAX_EMAIL = 320;

export type { LinkedVia };

/**
 * 第三方登录拒绝了这个身份（Ruling A18）：身份行经 IM 绑定链接建立，而请求没有带着同一账号的会话。
 * 登录页原因码 `sso.identity_not_verified`。
 */
export class IdentityNotVerified extends Error {
  constructor() {
    super("external identity is not verified for sign-in");
    this.name = "IdentityNotVerified";
  }
}

/** {@link ExternalIdentities.resolve} 的选项。 */
export interface ResolveOptions {
  /** 只有第三方登录路径传 true（Ruling A9）。 */
  allowMerge?: boolean;
  /** 新建身份行时记下的建立方式：第三方登录 `sso`，通讯录同步 `directory`。已有的行不改。 */
  linkedVia: "sso" | "directory";
  /**
   * 第三方登录路径：已有的身份行须可用于登录（见 {@link ExternalIdentities.resolve}）。
   * `sessionAccountId` 为请求已带着的 Web 会话的账号（没有会话时省略）。
   */
  login?: { sessionAccountId?: string };
}

/** 账号已绑定的一个外部身份（不含本地登录名）。 */
export interface LinkedIdentity {
  source: string;
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  /**
   * 身份行是怎么建立的（Ruling A18）：`bind` 只能在 IM 里代表本人，要用于第三方登录须本人登录后完成一次该身份的
   * 第三方登录（网页据此显示「验证」）；null 为 0019 之前的旧行（按 sso 处理）。
   */
  linkedVia: "bind" | "sso" | "directory" | "local" | null;
  createdAt: Date;
}

/** 身份源键里的插件名（`source` 中 `:` 之前的部分）。 */
export function identityPlugin(source: string): string {
  const i = source.indexOf(":");
  return i < 0 ? source : source.slice(0, i);
}

const invalid = (message: string) =>
  new ApiError("validation_failed", "Invalid external identity", [{ path: "identity", message }]);

/** 校验插件交来的外部身份（键的格式、长度），返回规范化后的副本。 */
function normalize(identity: ExternalIdentity): ExternalIdentity {
  const m = SOURCE_RE.exec(identity.source);
  if (!m || m[1] === "local") {
    throw invalid('source must be "<plugin>:<tenant>"');
  }
  // 身份源键的租户必须就是身份的租户（Ruling A19）：信任按租户判断，不能让键与租户各说各的
  if (identity.tenantId !== m[2]) {
    throw invalid("source tenant must equal tenantId");
  }
  if (
    typeof identity.externalId !== "string" ||
    identity.externalId.length === 0 ||
    identity.externalId.length > MAX_EXTERNAL_ID
  ) {
    throw invalid(`externalId must be 1-${MAX_EXTERNAL_ID} characters`);
  }
  const email =
    typeof identity.email === "string" && identity.email.length > 0
      ? identity.email.trim().slice(0, MAX_EMAIL)
      : undefined;
  const displayName =
    (typeof identity.displayName === "string" ? identity.displayName.trim() : "").slice(
      0,
      MAX_DISPLAY_NAME,
    ) || identity.externalId.slice(0, MAX_DISPLAY_NAME);
  return {
    source: identity.source,
    externalId: identity.externalId,
    tenantId: identity.tenantId,
    ...(email !== undefined && { email }),
    emailVerified: email !== undefined && identity.emailVerified === true,
    displayName,
    ...(typeof identity.avatarUrl === "string" && { avatarUrl: identity.avatarUrl.slice(0, 2000) }),
  };
}

const profileOf = (i: ExternalIdentity) =>
  JSON.stringify({
    tenantId: i.tenantId,
    displayName: i.displayName,
    ...(i.avatarUrl !== undefined && { avatarUrl: i.avatarUrl }),
  });

/**
 * 外部身份：按 `(source, externalId)` 映射到账号（登录、渠道入站、通讯录共用同一个键）。
 * 首次出现时按「受信任的身份源 + 两侧邮箱均已验证」合并到既有账号，否则新建账号（不建组织）。
 * 同一身份的并发首次解析用事务级咨询锁串行化，只建一个账号。框架无关，由调用方注入依赖。
 */
export class ExternalIdentities {
  constructor(
    private readonly db: KernelSchemaDb,
    private readonly config: () => {
      auth: Pick<KernelConfig["auth"], "trustedIdentitySources">;
    },
  ) {}

  /** 该外部身份绑定的账号 id；未绑定返回 undefined。 */
  async findAccount(source: string, externalId: string, trx?: Trx): Promise<string | undefined> {
    const row = await (trx ?? this.db)
      .selectFrom("identities")
      .select("account_id")
      .where("source", "=", source)
      .where("external_id", "=", externalId)
      .executeTakeFirst();
    return row?.account_id;
  }

  /**
   * 解析外部身份到账号。已绑定 → 该账号（顺带刷新身份行上的邮箱与资料）；未绑定 → 合并或新建（见类说明），
   * 新身份行记 `linked_via = opts.linkedVia`（合并也是 `sso`）。
   * 合并只在 `opts.allowMerge` 时考虑（Ruling A9：只有第三方登录路径传 true；渠道入站、通讯录不传）。
   * 第三方登录（`opts.login`，Ruling A18 / A23）：已有的身份行若经 IM 绑定建立（`bind`），只证明了某个网页登录者
   * 点过绑定链接，不证明他控制该外部身份——此时只有请求已带着**同一账号**的会话（本人在已登录状态下完成第三方登录，
   * 证明自己控制该身份）才放行，并把行升级为 `sso`（审计 `identity.verified`）；否则抛 {@link IdentityNotVerified}。
   * 通讯录建立的行（`directory`）不论租户是否受信任都可直接登录：身份源登录本身就证明登录者控制该身份，
   * 而通讯录身份总是指向为它新建的账号（信任只影响合并与 `email_verified`）。旧行（`linked_via` 为 null）按 `sso` 处理。
   * 新建账号的 `email_verified` 只在身份源受信任且身份邮箱已验证时为 true——不受信任的身份源可以声称任意邮箱
   * 「已验证」，不能让它建出的账号成为日后受信任登录的合并目标。
   * 合并写审计 `identity.linked`，新建写 `account.created`。不判断账号状态，由调用方决定（如登录拒绝停用账号）。
   * 传 `trx` 时在调用方事务内执行；与 `link` 取同一把咨询锁，兜底用 `ON CONFLICT DO NOTHING` 后回读，
   * 不抛唯一约束冲突、不中止调用方事务。
   */
  async resolve(
    identity: ExternalIdentity,
    trx: Trx | undefined,
    opts: ResolveOptions,
  ): Promise<{ accountId: string; created: boolean }> {
    const id = normalize(identity);
    const run = async (t: Trx) => {
      await this.lockIdentity(t, id);
      const existing = await this.findRow(t, id);
      if (existing !== undefined) {
        if (opts.login !== undefined) await this.allowLogin(t, id, existing, opts.login);
        await this.refreshIdentity(t, id);
        return { accountId: existing.accountId, created: false };
      }
      const merged = opts.allowMerge === true ? await this.mergeTarget(t, id) : undefined;
      if (merged !== undefined) {
        if (!(await this.insertIdentity(t, merged, id, "sso"))) {
          return { accountId: await this.mustFind(t, id), created: false };
        }
        await audit(t, {
          actorAccountId: merged,
          action: "identity.linked",
          target: merged,
          detail: { source: id.source, externalId: id.externalId, via: "verified_email" },
        });
        return { accountId: merged, created: false };
      }
      const accountId = randomUUID();
      await t
        .insertInto("accounts")
        .values({
          id: accountId,
          display_name: id.displayName,
          email: id.email ?? null,
          email_verified: id.emailVerified && this.trusted(id.source),
        })
        .execute();
      if (!(await this.insertIdentity(t, accountId, id, opts.linkedVia))) {
        // 不走咨询锁的写入方抢先插入了同一身份：撤销刚建的账号，回读
        await t.deleteFrom("accounts").where("id", "=", accountId).execute();
        return { accountId: await this.mustFind(t, id), created: false };
      }
      await audit(t, {
        actorAccountId: accountId,
        action: "account.created",
        target: accountId,
        detail: { source: id.source, externalId: id.externalId },
      });
      return { accountId, created: true };
    };
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  /** 同一身份的 resolve / link 串行化（事务级咨询锁）。 */
  private async lockIdentity(t: Trx, id: ExternalIdentity): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.identity:${id.source}:${id.externalId}`}))`.execute(
      t,
    );
  }

  /** 身份源键（`<插件名>:<租户 id>`）是否在 `auth.trustedIdentitySources` 中：按完整键比较，信任按租户（Ruling A19）。 */
  private trusted(source: string): boolean {
    return this.config().auth.trustedIdentitySources.includes(source);
  }

  private async findRow(
    t: Trx,
    id: ExternalIdentity,
  ): Promise<{ accountId: string; linkedVia: LinkedVia | null } | undefined> {
    const row = await t
      .selectFrom("identities")
      .select(["account_id", "linked_via"])
      .where("source", "=", id.source)
      .where("external_id", "=", id.externalId)
      .executeTakeFirst();
    return row && { accountId: row.account_id, linkedVia: row.linked_via };
  }

  /** 第三方登录能否用这一行（见 {@link resolve}）：只有 `bind` 行需要同一账号的会话，放行时把行改为 `sso`。 */
  private async allowLogin(
    t: Trx,
    id: ExternalIdentity,
    row: { accountId: string; linkedVia: LinkedVia | null },
    login: { sessionAccountId?: string },
  ): Promise<void> {
    const via = row.linkedVia ?? "sso";
    if (via !== "bind") return;
    if (login.sessionAccountId !== row.accountId) throw new IdentityNotVerified();
    await t
      .updateTable("identities")
      .set({ linked_via: "sso" })
      .where("source", "=", id.source)
      .where("external_id", "=", id.externalId)
      .execute();
    await audit(t, {
      actorAccountId: row.accountId,
      action: "identity.verified",
      target: row.accountId,
      detail: { source: id.source, externalId: id.externalId, from: via },
    });
  }

  private async mustFind(t: Trx, id: ExternalIdentity): Promise<string> {
    const owner = await this.findAccount(id.source, id.externalId, t);
    if (owner === undefined) throw new Error("identity vanished after a conflicting insert");
    return owner;
  }

  private async refreshIdentity(t: Trx, id: ExternalIdentity): Promise<void> {
    await t
      .updateTable("identities")
      .set({ email: id.email ?? null, email_verified: id.emailVerified, profile: profileOf(id) })
      .where("source", "=", id.source)
      .where("external_id", "=", id.externalId)
      .execute();
  }

  /**
   * 可合并的既有账号：身份源键在 `auth.trustedIdentitySources` 中、身份邮箱已验证，
   * 且恰好有一个邮箱已验证、邮箱相同（不区分大小写）的账号；否则 undefined（多个候选时不猜，新建）。
   */
  private async mergeTarget(t: Trx, id: ExternalIdentity): Promise<string | undefined> {
    if (!id.emailVerified || id.email === undefined || !this.trusted(id.source)) return undefined;
    const rows = await t
      .selectFrom("accounts")
      .select("id")
      .where("email_verified", "=", true)
      .where(sql<string>`lower(email)`, "=", id.email.toLowerCase())
      .limit(2)
      .execute();
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  /** 插入身份行；已存在（主键冲突）时什么都不做并返回 false。 */
  private async insertIdentity(
    t: Trx,
    accountId: string,
    id: ExternalIdentity,
    linkedVia: LinkedVia,
  ): Promise<boolean> {
    const row = await t
      .insertInto("identities")
      .values({
        source: id.source,
        external_id: id.externalId,
        account_id: accountId,
        email: id.email ?? null,
        email_verified: id.emailVerified,
        profile: profileOf(id),
        linked_via: linkedVia,
      })
      .onConflict((oc) => oc.columns(["source", "external_id"]).doNothing())
      .returning("account_id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * 把外部身份绑定到账号（IM 里点绑定链接等）：已绑定本人 → 刷新资料，幂等（不改 `linked_via`）；
   * 已绑定他人 → `409 identity.taken`。新行记 `linked_via = bind`：这样绑定的身份只能在 IM 里代表此人，
   * 不能直接用于第三方登录（Ruling A18）。与 `resolve` 取同一把咨询锁。新绑定写审计 `identity.linked`。
   */
  async link(accountId: string, identity: ExternalIdentity, trx?: Trx): Promise<void> {
    const id = normalize(identity);
    const run = async (t: Trx) => {
      await this.lockIdentity(t, id);
      const owner = await this.findAccount(id.source, id.externalId, t);
      if (owner !== undefined && owner !== accountId) throw taken();
      if (owner === accountId) {
        await this.refreshIdentity(t, id);
        return;
      }
      if (!(await this.insertIdentity(t, accountId, id, "bind"))) {
        if ((await this.mustFind(t, id)) !== accountId) throw taken();
        return;
      }
      await audit(t, {
        actorAccountId: accountId,
        action: "identity.linked",
        target: accountId,
        detail: { source: id.source, externalId: id.externalId, via: "bind" },
      });
    };
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  /**
   * 解除本人的一个外部身份（本地登录名不可解除）；不存在或不属于本人 → `identity.not_found`；
   * 账号没有本地密码且这是最后一个外部身份 → `409 identity.last_login_method`。审计 `identity.unlinked`。
   */
  async unlink(accountId: string, source: string, externalId: string): Promise<void> {
    if (source === "local") throw notFound();
    await this.db.transaction().execute(async (t) => {
      const r = await t
        .deleteFrom("identities")
        .where("source", "=", source)
        .where("external_id", "=", externalId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      if (r.numDeletedRows === 0n) throw notFound();
      // 没有本地密码时至少还要剩一个外部身份，否则此人再也登录不了（锁账号行，串行化并发解除）
      await t.selectFrom("accounts").select("id").where("id", "=", accountId).forUpdate().execute();
      const password = await t
        .selectFrom("local_passwords")
        .select("account_id")
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      const others = await t
        .selectFrom("identities")
        .select("source")
        .where("account_id", "=", accountId)
        .where("source", "!=", "local")
        .limit(1)
        .execute();
      if (!password && others.length === 0) {
        throw new ApiError(
          "identity.last_login_method",
          "Cannot unlink the last sign-in method of an account without a password",
        );
      }
      await audit(t, {
        actorAccountId: accountId,
        action: "identity.unlinked",
        target: accountId,
        detail: { source, externalId },
      });
    });
  }

  /** 账号绑定的外部身份（不含本地登录名），按绑定时间升序。 */
  async listForAccount(accountId: string): Promise<LinkedIdentity[]> {
    const rows = await this.db
      .selectFrom("identities")
      .select([
        "source",
        "external_id",
        "email",
        "email_verified",
        "profile",
        "linked_via",
        "created_at",
      ])
      .where("account_id", "=", accountId)
      .where("source", "!=", "local")
      .orderBy("created_at")
      .orderBy("source")
      .orderBy("external_id")
      .execute();
    return rows.map((r) => {
      const p = (r.profile ?? {}) as { displayName?: unknown; avatarUrl?: unknown };
      return {
        source: r.source,
        externalId: r.external_id,
        email: r.email,
        emailVerified: r.email_verified,
        displayName: typeof p.displayName === "string" ? p.displayName : null,
        avatarUrl: typeof p.avatarUrl === "string" ? p.avatarUrl : null,
        linkedVia: r.linked_via,
        createdAt: r.created_at,
      };
    });
  }
}

const taken = () =>
  new ApiError("identity.taken", "This external identity is already linked to another account");
const notFound = () => new ApiError("identity.not_found", "External identity not found");
