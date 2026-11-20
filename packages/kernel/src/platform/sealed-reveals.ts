import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { platformSealedRevealAad as aadOf, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KEYRING } from "../infra/tokens.js";

/**
 * How long a sealed invitation link waits for its reader, like a generated initial password: the
 * approving person reads it right after the call runs; one never read expires (revoke the
 * invitation and invite again).
 */
export const SEALED_REVEAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The tool key of the approval an invitation link belongs to. */
export const INVITE_TOOL_KEY = "Platform:orgs.invite";

/** Where a sealed value is delivered: the approved tool call and the person who approved. */
export interface SealedRevealDelivery {
  conversationId: string;
  /** The run of the call: a call id is unique only within its run. */
  runId: string;
  callId: string;
  /** The account that may read it: the actor who confirmed the call. */
  recipientAccountId: string;
}

/** The web path of an invitation link (apps/web `invitePath`). */
export const invitationPath = (token: string) => `/invite/${encodeURIComponent(token)}`;

/**
 * Values a Platform call makes that only the person who approved the call may read (platform web
 * parity spec §7.2, plan ruling R10): the token of an invitation an org admin's agent created. The
 * token never reaches the model, the tool result, the event log, the audit or a log line: it is
 * sealed with the master keyring in the creation's transaction and read once, on the web, by the
 * person who approved the call, like the generated initial password (`InitialPasswords`).
 */
@Injectable()
export class SealedReveals {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  /** Seals an invitation's token for `to`, in the caller's (the creation's) transaction. */
  @Transactional({ propagation: "mandatory" })
  async sealIn(
    orgId: string,
    invitationId: string,
    token: string,
    to: SealedRevealDelivery,
  ): Promise<void> {
    const plain = Buffer.from(token, "utf8");
    const { data, masterKeyId } = this.keyring.wrap(plain, aadOf(invitationId));
    plain.fill(0);
    await this.db
      .insertInto("platform_sealed_reveals")
      .values({
        id: invitationId,
        kind: "invitation_link",
        org_id: orgId,
        recipient_account_id: to.recipientAccountId,
        conversation_id: to.conversationId,
        run_id: to.runId,
        call_id: to.callId,
        master_key_id: masterKeyId,
        ciphertext: data,
        // the DB clock, the same one reveal and the cleanup compare against
        expires_at: sql<Date>`now() + make_interval(secs => ${SEALED_REVEAL_TTL_MS / 1000})`,
      })
      .execute();
  }

  /**
   * The link of the invitation an approved `orgs.invite` call created, read once by the person who
   * approved it (`approvalId` in `orgId`, decided by `accountId`), then deleted. Anything else (not
   * that person, not approved, not run yet, read already, expired, the invitation no longer
   * pending) is `invitation.link_unavailable`, saying nothing about which. Audits the read
   * (without the token). The URL is absolute under `http.publicUrl`, else the web path.
   */
  @Transactional()
  async reveal(orgId: string, approvalId: string, accountId: string): Promise<{ url: string }> {
    const unavailable = () =>
      new ApiError(
        "invitation.link_unavailable",
        "No invitation link to show: it was shown already, has expired, the invitation is no longer pending, or it was not created by a call you approved",
      );
    const approval = await this.db
      .selectFrom("approvals")
      .select(["conversation_id", "run_id", "call_id", "tool_key", "status", "decided_by"])
      .where("id", "=", approvalId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (
      approval === undefined ||
      approval.tool_key !== INVITE_TOOL_KEY ||
      approval.status !== "approved" ||
      approval.decided_by !== accountId
    ) {
      throw unavailable();
    }
    // exactly the row of this approval's call, for a still pending invitation: deleted as read
    const row = await this.db
      .deleteFrom("platform_sealed_reveals")
      .where("kind", "=", "invitation_link")
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", approval.conversation_id)
      .where("run_id", "=", approval.run_id)
      .where("call_id", "=", approval.call_id)
      .where("recipient_account_id", "=", accountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("invitations")
            .select("invitations.id")
            .whereRef("invitations.id", "=", "platform_sealed_reveals.id")
            .where("invitations.accepted_at", "is", null)
            .where("invitations.revoked_at", "is", null)
            .where(sql<boolean>`invitations.expires_at > now()`),
        ),
      )
      .returning(["id", "master_key_id", "ciphertext"])
      .executeTakeFirst();
    if (row === undefined) throw unavailable();
    let token: string;
    try {
      token = this.keyring
        .unwrap(row.master_key_id, Buffer.from(row.ciphertext), aadOf(row.id))
        .toString("utf8");
    } catch {
      throw unavailable();
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      orgId,
      action: "org.invitation.link_shown",
      target: row.id,
      detail: { approvalId },
    });
    const base = this.config.get().http.publicUrl?.replace(/\/+$/, "") ?? "";
    return { url: `${base}${invitationPath(token)}` };
  }
}

/** Deletes the sealed reveals past `expires_at`; returns how many. */
export async function deleteExpiredSealedReveals(db: KernelSchemaDb): Promise<number> {
  const r = await db
    .deleteFrom("platform_sealed_reveals")
    .where("expires_at", "<=", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
