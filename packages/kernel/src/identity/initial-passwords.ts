import { randomInt } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { accessibleTo } from "../conversations/access.js";
import { initialPasswordAad as aadOf, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KEYRING } from "../infra/tokens.js";
import { type Account, AccountsService } from "./accounts.js";
import { audit } from "./audit.js";

/** Letters and digits without the look-alikes (0 O 1 l I): read off a screen and typed by hand. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** 20 characters of 56: about 116 bits. */
const LENGTH = 20;

/**
 * How long a generated password waits for its reader. The person the call was made for reads it
 * right after the call runs; one that is never read expires (the account can still be disabled
 * and recreated).
 */
export const INITIAL_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

/** A one-time initial password, cryptographically random. */
export function generateInitialPassword(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * The tool call a once-shown value (an initial password, an invitation link) was made by: a call
 * id is unique only within its run.
 */
export interface RevealCall {
  conversationId: string;
  runId: string;
  callId: string;
}

/** Where a generated password is delivered: the tool call and the person it was made for. */
export interface InitialPasswordDelivery {
  conversationId: string;
  /** The run of the call: a call id is unique only within its run. */
  runId: string;
  callId: string;
  /** The account that may read it: the person the call was made for (the run's own person). */
  recipientAccountId: string;
}

/**
 * Accounts created with a kernel-generated one-time password (Platform tool spec §14.5 item 2).
 * The password never leaves the kernel except through {@link reveal}: it is not returned to the
 * caller, not written to the audit, the event log or the logs. It is sealed with the master keyring
 * in the creation's transaction and read once, on the web, by the person the call was made for.
 */
@Injectable()
export class InitialPasswords {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  /**
   * Creates a local account (never a super admin) with a generated password it must change at
   * first sign-in, and seals the password for `to`. Returns the account only.
   */
  async createAccount(
    input: { login: string; displayName: string; email?: string },
    actorAccountId: string,
    to: InitialPasswordDelivery,
    auditDetail?: Record<string, unknown>,
  ): Promise<Account> {
    const password = generateInitialPassword();
    return this.accounts.createByAdmin(
      { ...input, password, superAdmin: false, mustChangePassword: true },
      actorAccountId,
      undefined,
      {
        ...(auditDetail !== undefined && { auditDetail }),
        inTransaction: (account) => this.seal(account.id, password, to),
      },
    );
  }

  /** Stores the sealed password in the creation's transaction (the hourly job drops expired ones). */
  private async seal(
    accountId: string,
    password: string,
    to: InitialPasswordDelivery,
  ): Promise<void> {
    const { data, masterKeyId } = this.keyring.wrap(
      Buffer.from(password, "utf8"),
      aadOf(accountId),
    );
    await this.db
      .insertInto("account_initial_passwords")
      .values({
        account_id: accountId,
        recipient_account_id: to.recipientAccountId,
        conversation_id: to.conversationId,
        run_id: to.runId,
        call_id: to.callId,
        master_key_id: masterKeyId,
        ciphertext: data,
        expires_at: new Date(Date.now() + INITIAL_PASSWORD_TTL_MS),
      })
      .execute();
  }

  /**
   * The password created by an `accounts.create` call (`call` in `orgId`), read once by its
   * recipient `accountId` while the call's conversation is still accessible to them, then deleted
   * (plan ruling R6: read by call, whether the call ran under an approval or automatically).
   * Anything else (not the recipient, the conversation not accessible, not run yet, read already,
   * expired) is `account.initial_password_unavailable`, saying nothing about which. Audits the read
   * (without the password).
   */
  @Transactional()
  async reveal(
    orgId: string,
    call: RevealCall,
    accountId: string,
  ): Promise<{ accountId: string; login: string | null; password: string }> {
    const unavailable = () =>
      new ApiError(
        "account.initial_password_unavailable",
        "No initial password to show: it was shown already, has expired, or the account was not created by a call made for you",
      );
    // exactly the row of this call, for its recipient in a conversation of this org they can
    // still see: locked, then deleted by its key
    const found = await this.db
      .selectFrom("account_initial_passwords")
      .select("account_id")
      .where("conversation_id", "=", call.conversationId)
      .where("run_id", "=", call.runId)
      .where("call_id", "=", call.callId)
      .where("recipient_account_id", "=", accountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("conversations")
            .select("conversations.id")
            .whereRef("conversations.id", "=", "account_initial_passwords.conversation_id")
            .where("conversations.org_id", "=", orgId)
            .where(accessibleTo(accountId)),
        ),
      )
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (found === undefined) throw unavailable();
    const row = await this.db
      .deleteFrom("account_initial_passwords")
      .where("account_id", "=", found.account_id)
      .returning(["account_id", "master_key_id", "ciphertext"])
      .executeTakeFirst();
    if (row === undefined) throw unavailable();
    const password = this.keyring
      .unwrap(row.master_key_id, row.ciphertext, aadOf(row.account_id))
      .toString("utf8");
    const login = (await this.accounts.localLogins([row.account_id])).get(row.account_id) ?? null;
    await audit(this.db.db, {
      actorAccountId: accountId,
      orgId,
      action: "account.initial_password_shown",
      target: row.account_id,
      detail: { conversationId: call.conversationId, runId: call.runId, callId: call.callId },
    });
    return { accountId: row.account_id, login, password };
  }
}

/** Deletes the sealed passwords past `expires_at`; returns how many. */
export async function deleteExpiredInitialPasswords(db: KernelSchemaDb): Promise<number> {
  const r = await db
    .deleteFrom("account_initial_passwords")
    .where("expires_at", "<=", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
