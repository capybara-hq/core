import { randomBytes, randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type { ApiTokensTable, KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { roleAtLeast } from "../orgs/roles.js";
import { audit } from "./audit.js";
import { sha256Hex } from "./hash.js";

export interface ApiTokenRecord {
  id: string;
  kind: "personal" | "service";
  accountId: string | null;
  orgId: string | null;
  role: "admin" | "member" | "guest" | null;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

type Scope = { accountId: string } | { orgId: string };

const PREFIX = { personal: "cap_pat_", service: "cap_svc_" } as const;

function toRecord(r: Selectable<ApiTokensTable>): ApiTokenRecord {
  return {
    id: r.id,
    kind: r.kind,
    accountId: r.account_id,
    orgId: r.org_id,
    role: r.role,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  };
}

function validate(input: { name: string; expiresAt?: Date | undefined }): void {
  if (input.name.length < 1 || input.name.length > 100) {
    throw new ApiError("validation_failed", "Token name must be 1-100 characters");
  }
  if (input.expiresAt !== undefined && !(input.expiresAt.getTime() > Date.now())) {
    throw new ApiError("validation_failed", "Token expiry must be in the future");
  }
}

/**
 * API 令牌服务：个人令牌（`cap_pat_`，代表账号本人）与服务令牌（`cap_svc_`，属于组织、带角色）。
 * 库里只存 sha256；明文只在创建时返回一次。框架无关，由调用方注入 db。
 */
export class ApiTokenService {
  constructor(private readonly db: KernelDb) {}

  async createPersonal(
    accountId: string,
    input: { name: string; expiresAt?: Date | undefined },
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    validate(input);
    return this.insert("personal", {
      account_id: accountId,
      org_id: null,
      role: null,
      name: input.name,
      created_by: accountId,
      expires_at: input.expiresAt ?? null,
    });
  }

  async createService(
    orgId: string,
    input: {
      name: string;
      role: "admin" | "member" | "guest";
      createdBy: string;
      expiresAt?: Date | undefined;
    },
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    validate(input);
    return this.insert("service", {
      account_id: null,
      org_id: orgId,
      role: input.role,
      name: input.name,
      created_by: input.createdBy,
      expires_at: input.expiresAt ?? null,
    });
  }

  /**
   * 以账号身份创建服务令牌：在组织行锁内实时重读发起人角色（spec 3.6 R5），
   * 须具备 `org.tokens.manage` 且令牌角色不高于发起人角色，否则 `forbidden`；同一事务写审计（不含令牌明文）。
   */
  async createServiceAs(
    orgId: string,
    actorAccountId: string,
    input: { name: string; role: "admin" | "member" | "guest"; expiresAt?: Date | undefined },
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    validate(input);
    return this.db.transaction().execute(async (t) => {
      const { role } = await lockOrgAndAuthorize(t, orgId, actorAccountId, "org.tokens.manage");
      if (!roleAtLeast(role, input.role)) {
        throw new ApiError("forbidden", "Insufficient organization role");
      }
      const created = await this.insert(
        "service",
        {
          account_id: null,
          org_id: orgId,
          role: input.role,
          name: input.name,
          created_by: actorAccountId,
          expires_at: input.expiresAt ?? null,
        },
        t,
      );
      await audit(t, {
        actorAccountId,
        orgId,
        action: "org.service_token.created",
        target: created.record.id,
        detail: { name: input.name, role: input.role },
      });
      return created;
    });
  }

  /**
   * 以账号身份吊销组织服务令牌并写审计（同一事务）：同 createServiceAs 在组织行锁内实时复核发起人角色
   * （组织不存在 / 已删除 → `org.not_found`，无 `org.tokens.manage` → `forbidden`）；不在该组织内 → `token.not_found`。
   */
  async revokeServiceAs(orgId: string, tokenId: string, actorAccountId: string): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "org.tokens.manage");
      await this.revoke(tokenId, { orgId }, t);
      await audit(t, {
        actorAccountId,
        orgId,
        action: "org.service_token.revoked",
        target: tokenId,
      });
    });
  }

  /** 校验令牌明文；未知、已吊销、已过期或前缀不对一律返回 null。 */
  async authenticate(token: string): Promise<ApiTokenRecord | null> {
    const kind = token.startsWith(PREFIX.personal)
      ? "personal"
      : token.startsWith(PREFIX.service)
        ? "service"
        : undefined;
    if (!kind) return null;
    const row = await this.db
      .selectFrom("api_tokens")
      .selectAll()
      .where("token_hash", "=", sha256Hex(token))
      .where("kind", "=", kind)
      .where("revoked_at", "is", null)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
      .executeTakeFirst();
    if (!row) return null;
    // 节流：同一令牌 5 分钟内最多写一次 last_used_at
    const touched = await this.db
      .updateTable("api_tokens")
      .set({ last_used_at: sql<Date>`now()` })
      .where("id", "=", row.id)
      .where((eb) =>
        eb.or([
          eb("last_used_at", "is", null),
          eb("last_used_at", "<", sql<Date>`now() - interval '5 minutes'`),
        ]),
      )
      .returning("last_used_at")
      .executeTakeFirst();
    const record = toRecord(row);
    if (touched) record.lastUsedAt = touched.last_used_at;
    return record;
  }

  /** 列出该 scope 下未吊销的令牌（含已过期），按创建时间升序。 */
  async list(scope: Scope): Promise<ApiTokenRecord[]> {
    const rows = await this.scoped(this.db.selectFrom("api_tokens").selectAll(), scope)
      .where("revoked_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(toRecord);
  }

  /** 吊销令牌；令牌不存在、已吊销或不在该 scope 内 → `token.not_found`。 */
  async revoke(id: string, scope: Scope, trx?: Transaction<KernelDatabase>): Promise<void> {
    const r = await this.scoped(
      (trx ?? this.db).updateTable("api_tokens").set({ revoked_at: sql<Date>`now()` }),
      scope,
    )
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) throw new ApiError("token.not_found", "Token not found");
  }

  async revokeAllForOrg(orgId: string, trx?: Transaction<KernelDatabase>): Promise<void> {
    await (trx ?? this.db)
      .updateTable("api_tokens")
      .set({ revoked_at: sql<Date>`now()` })
      .where("kind", "=", "service")
      .where("org_id", "=", orgId)
      .where("revoked_at", "is", null)
      .execute();
  }

  async revokeAllPersonal(accountId: string): Promise<void> {
    await this.db
      .updateTable("api_tokens")
      .set({ revoked_at: sql<Date>`now()` })
      .where("kind", "=", "personal")
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .execute();
  }

  private scoped<
    Q extends {
      where(col: "kind" | "account_id" | "org_id", op: "=", v: string): Q;
    },
  >(q: Q, scope: Scope): Q {
    return "accountId" in scope
      ? q.where("kind", "=", "personal").where("account_id", "=", scope.accountId)
      : q.where("kind", "=", "service").where("org_id", "=", scope.orgId);
  }

  private async insert(
    kind: "personal" | "service",
    values: {
      account_id: string | null;
      org_id: string | null;
      role: "admin" | "member" | "guest" | null;
      name: string;
      created_by: string;
      expires_at: Date | null;
    },
    trx?: Transaction<KernelDatabase>,
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    const token = PREFIX[kind] + randomBytes(32).toString("base64url");
    const row = await (trx ?? this.db)
      .insertInto("api_tokens")
      .values({ id: randomUUID(), kind, token_hash: sha256Hex(token), ...values })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { token, record: toRecord(row) };
  }
}
