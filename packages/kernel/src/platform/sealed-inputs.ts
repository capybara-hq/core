import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type Keyring, platformSealedInputAad } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KEYRING } from "../infra/tokens.js";

/** How long a person's sealed card values wait for the resumed call, from the decision. */
export const SEALED_INPUT_TTL_MS = 15 * 60 * 1000;

/**
 * The sealed values are gone: consumed already, expired, not this recipient's, or no longer
 * unwrappable. Says nothing about which.
 */
export class SealedInputsExpiredError extends Error {
  constructor() {
    super("The sealed person inputs are no longer available");
    this.name = "SealedInputsExpiredError";
  }
}

/** The approved call the values belong to, and the person who typed them. */
export interface SealedInputsRow {
  approvalId: string;
  recipientAccountId: string;
  conversationId: string;
  /** The run of the call: a call id is unique only within its run. */
  runId: string;
  callId: string;
}

/**
 * Values a person typed on an approval card for a Platform call's secret fields (platform web
 * parity spec §4.3). They are sealed with the master keyring in the decision's transaction and
 * consumed once by the resumed call, in the transaction that applies the write. They never reach
 * the event log, a tool result, the approval row, the audit or a log line.
 */
@Injectable()
export class SealedInputs {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KEYRING) private readonly keyring: Keyring,
  ) {}

  /** Seals `values` for the approval, in the caller's (the decision's) transaction. */
  @Transactional({ propagation: "mandatory" })
  async sealIn(row: SealedInputsRow, values: Readonly<Record<string, string>>): Promise<void> {
    const paths = Object.keys(values).sort();
    const plain = Buffer.from(JSON.stringify(values), "utf8");
    const { data, masterKeyId } = this.keyring.wrap(
      plain,
      platformSealedInputAad(row.approvalId, paths),
    );
    plain.fill(0);
    await this.db
      .insertInto("platform_sealed_inputs")
      .values({
        approval_id: row.approvalId,
        recipient_account_id: row.recipientAccountId,
        conversation_id: row.conversationId,
        run_id: row.runId,
        call_id: row.callId,
        paths,
        master_key_id: masterKeyId,
        ciphertext: data,
        expires_at: new Date(Date.now() + SEALED_INPUT_TTL_MS),
      })
      .execute();
  }

  /**
   * Locks, deletes and unwraps the approval's values for `recipientAccountId`, then runs `apply`
   * with them in the same transaction: when `apply` throws, the row comes back. A row that is
   * missing, expired, another person's or not unwrappable is {@link SealedInputsExpiredError}.
   */
  @Transactional()
  async consume<T>(
    approvalId: string,
    recipientAccountId: string,
    apply: (values: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const row = await this.db
      .deleteFrom("platform_sealed_inputs")
      .where("approval_id", "=", approvalId)
      .where("recipient_account_id", "=", recipientAccountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .returning(["approval_id", "paths", "master_key_id", "ciphertext"])
      .executeTakeFirst();
    if (row === undefined) throw new SealedInputsExpiredError();
    let values: Record<string, string>;
    try {
      const plain = this.keyring.unwrap(
        row.master_key_id,
        Buffer.from(row.ciphertext),
        platformSealedInputAad(row.approval_id, row.paths),
      );
      values = JSON.parse(plain.toString("utf8")) as Record<string, string>;
      plain.fill(0);
    } catch {
      throw new SealedInputsExpiredError();
    }
    return apply(values);
  }
}

/** Deletes the sealed person inputs past `expires_at`; returns how many. */
export async function deleteExpiredSealedInputs(db: KernelSchemaDb): Promise<number> {
  const r = await db
    .deleteFrom("platform_sealed_inputs")
    .where("expires_at", "<=", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
