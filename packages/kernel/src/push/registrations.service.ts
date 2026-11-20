import { randomUUID } from "node:crypto";
import { PUSH_LIMITS } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import type { PushRegistrationsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PushProviderHost } from "./provider-host.js";
import type { PushRegistrationBody, PushRegistrationView } from "./push.schemas.js";
import { PushTokenStore } from "./token-store.js";

/** A stored registration, its token still sealed. */
export type PushRegistrationRow = Selectable<PushRegistrationsTable>;

/** Every column but the sealed token, for the reads that never need it. */
const VIEW_COLUMNS = [
  "id",
  "session_id",
  "platform",
  "app_id",
  "provider",
  "device_name",
  "locale",
  "created_at",
  "last_seen_at",
] as const;

/**
 * A person's app installs that receive push (mobile app spec §9.3). A registration belongs to the
 * account, not an org, and follows the session that posted it (plan decision 3). A token posted
 * again, by anyone, updates the one row of `(provider, app_id, token_hash)` and keeps its id, so
 * the sealed token (AAD bound to the id) still opens; a phone that changes hands stops reaching its
 * previous account (decision 5). The token is never logged, audited or answered.
 */
@Injectable()
export class PushRegistrationsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PushTokenStore) private readonly tokens: PushTokenStore,
    @Inject(PushProviderHost) private readonly providers: PushProviderHost,
  ) {}

  /**
   * Registers (or refreshes) an install for `accountId` from `sessionId`. A provider that is not
   * loaded or does not cover the app id → 422 `push.provider_unavailable`; a session revoked since
   * the request was authenticated → 401 `auth.session_revoked`. Beyond
   * `PUSH_LIMITS.registrationsPerAccount` the least recently seen of the account are deleted.
   * Audited (`push.registered`) for a new row or a row taken from another account.
   */
  @Transactional()
  async register(
    accountId: string,
    sessionId: string,
    body: PushRegistrationBody,
  ): Promise<{ id: string }> {
    if (!this.providers.covers(body.provider, body.appId)) {
      throw new ApiError(
        "push.provider_unavailable",
        "No enabled push provider of that name covers this app id",
      );
    }
    // The account row first (registrations of one account are serialized, so the cap holds),
    // then the session row. Safe against the revoke paths: a disable updates the account row
    // before its sessions, the same order; a password change holds only KEY SHARE on the account
    // (through the foreign key; it updates the row, before its sessions, only while
    // must_change_password is set), which does not conflict with FOR NO KEY UPDATE.
    await this.db
      .selectFrom("accounts")
      .select("id")
      .where("id", "=", accountId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    // Locked against revocation: a revoke that commits first is seen here, one that comes after
    // waits and then deletes this registration with the session's others.
    const session = await this.db
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", sessionId)
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .forShare()
      .executeTakeFirst();
    if (!session) throw new ApiError("auth.session_revoked", "Session has been revoked");

    const tokenHash = PushTokenStore.hash(body.token);
    // a unique conflict whose winning row is gone again (a revoke deleted it) is retried once
    const placed =
      (await this.place(accountId, sessionId, body, tokenHash)) ??
      (await this.place(accountId, sessionId, body, tokenHash));
    if (!placed) throw new Error("push registration conflicted twice with a deleted row");
    const { id, changedHands } = placed;
    await this.evictBeyondCap(accountId);
    if (changedHands) {
      await audit(this.db.db, {
        actorAccountId: accountId,
        action: "push.registered",
        target: id,
        detail: {
          registrationId: id,
          platform: body.platform,
          appId: body.appId,
          provider: body.provider,
          deviceName: body.deviceName,
        },
      });
    }
    return { id };
  }

  /** Removes one of the person's registrations; another account's id → 404. Audited. */
  @Transactional()
  async remove(accountId: string, id: string): Promise<void> {
    const row = await this.db
      .deleteFrom("push_registrations")
      .where("id", "=", id)
      .where("account_id", "=", accountId)
      .returning("id")
      .executeTakeFirst();
    if (!row) throw new ApiError("push.registration_not_found", "Push registration not found");
    await audit(this.db.db, {
      actorAccountId: accountId,
      action: "push.unregistered",
      target: id,
      detail: { registrationId: id, reason: "person" },
    });
  }

  /** The person's registrations, newest `last_seen_at` first; `current` = posted by `sessionId`. */
  async list(accountId: string, sessionId: string): Promise<PushRegistrationView[]> {
    const rows = await this.db
      .selectFrom("push_registrations")
      .select(VIEW_COLUMNS)
      .where("account_id", "=", accountId)
      .orderBy("last_seen_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      appId: r.app_id,
      provider: r.provider,
      deviceName: r.device_name,
      locale: r.locale,
      createdAt: r.created_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      current: r.session_id === sessionId,
    }));
  }

  /** The registrations of these accounts, tokens still sealed (the fanout opens them per send). */
  async forAccounts(accountIds: readonly string[]): Promise<PushRegistrationRow[]> {
    if (accountIds.length === 0) return [];
    return this.db
      .selectFrom("push_registrations")
      .selectAll()
      .where("account_id", "in", [...accountIds])
      .orderBy("id")
      .execute();
  }

  /**
   * Updates the row of this token in place (keeping its id) or inserts a sealed new one; null
   * when the insert lost a unique conflict to a row that is already gone again.
   */
  private async place(
    accountId: string,
    sessionId: string,
    body: PushRegistrationBody,
    tokenHash: string,
  ): Promise<{ id: string; changedHands: boolean } | null> {
    const existing = await this.lockExisting(body.provider, body.appId, tokenHash);
    if (existing) {
      await this.refresh(existing.id, accountId, sessionId, body);
      return { id: existing.id, changedHands: existing.account_id !== accountId };
    }
    const id = randomUUID();
    const sealed = this.tokens.seal(id, body.token);
    // ON CONFLICT waits for a concurrent insert of the same token; on its commit this inserts
    // nothing and the caller's retry finds and takes that row
    const inserted = await this.db
      .insertInto("push_registrations")
      .values({
        id,
        account_id: accountId,
        session_id: sessionId,
        platform: body.platform,
        app_id: body.appId,
        provider: body.provider,
        token_hash: sealed.tokenHash,
        master_key_id: sealed.masterKeyId,
        token_ciphertext: sealed.ciphertext,
        locale: body.locale,
        device_name: body.deviceName,
      })
      .onConflict((oc) => oc.columns(["provider", "app_id", "token_hash"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted ? { id, changedHands: true } : null;
  }

  private lockExisting(provider: string, appId: string, tokenHash: string) {
    return this.db
      .selectFrom("push_registrations")
      .select(["id", "account_id"])
      .where("provider", "=", provider)
      .where("app_id", "=", appId)
      .where("token_hash", "=", tokenHash)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Points an existing row at the caller and its session; the id and the sealed token stay. */
  private async refresh(
    id: string,
    accountId: string,
    sessionId: string,
    body: PushRegistrationBody,
  ): Promise<void> {
    await this.db
      .updateTable("push_registrations")
      .set({
        account_id: accountId,
        session_id: sessionId,
        locale: body.locale,
        device_name: body.deviceName,
        last_seen_at: sql<Date>`now()`,
      })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Deletes the account's registrations beyond the cap, least recently seen first. Rows locked by
   * another transaction are skipped (`FOR UPDATE SKIP LOCKED`), never waited for: a concurrent
   * revoke of another session deleting its rows would otherwise deadlock with this (40P01). A
   * skipped row is on its way out (a revoke) or to another account (a reassignment), so it does
   * not count toward the 20 kept; the cap stays exact once those commit.
   */
  private async evictBeyondCap(accountId: string): Promise<void> {
    await this.db
      .deleteFrom("push_registrations")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("push_registrations")
          .select("id")
          .where("account_id", "=", accountId)
          .orderBy("last_seen_at", "desc")
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .offset(PUSH_LIMITS.registrationsPerAccount)
          .forUpdate()
          .skipLocked(),
      )
      .execute();
  }
}
