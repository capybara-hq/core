import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import { audit } from "../identity/audit.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import {
  type AuthorityLevel,
  type AuthoritySubject,
  PermissionAuthorityLock,
} from "./permission-authority-lock.js";
export const PERMISSION_APPROVAL_RECHECK = "permission-approval-recheck";
export type PermissionTransition = {
  orgId: string;
  rootConversationId: string;
  deviceId: string | null;
  oldProfile: PermissionProfile;
  newProfile: PermissionProfile;
  revision: number;
  scopeRevision: string | null;
  actorAccountId: string | null;
  reason: "user" | "authority-changed";
};
/** Canonical lower write: never takes descendant authority or imports the tools domain. */
@Injectable()
export class PermissionTransitions {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}
  @Transactional({ propagation: "mandatory" })
  async recordLocked(
    change: PermissionTransition,
    writer: { subject: AuthoritySubject; level: AuthorityLevel },
  ): Promise<void> {
    const id =
      writer.level === "platform"
        ? "platform"
        : writer.level === "org"
          ? writer.subject.orgId
          : writer.level === "device"
            ? writer.subject.deviceId
            : writer.subject.rootConversationId;
    if (!id) throw new Error("Permission transition requires the actual writer subject");
    this.locks.assertHeld(writer.level, id, true);
    if (
      (writer.level !== "platform" && writer.subject.orgId !== change.orgId) ||
      (writer.level === "device" && writer.subject.deviceId !== change.deviceId) ||
      (writer.level === "root" && writer.subject.rootConversationId !== change.rootConversationId)
    )
      throw new Error("Permission transition does not belong to this writer");
    const root = await this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", change.rootConversationId)
      .where("org_id", "=", change.orgId)
      .executeTakeFirstOrThrow();
    if (
      root.parent_conversation_id ||
      root.permission_revision !== change.revision ||
      root.permission_profile !== change.newProfile ||
      root.device_id !== change.deviceId
    )
      throw new Error("Permission transition does not match the persisted root");
    const tree = await this.db
      .withRecursive("tree(id)", (db) =>
        db
          .selectFrom("conversations")
          .select("id")
          .where("id", "=", change.rootConversationId)
          .unionAll((q) =>
            q
              .selectFrom("conversations as c")
              .innerJoin("tree", "tree.id", "c.parent_conversation_id")
              .select("c.id")
              .where("c.org_id", "=", change.orgId),
          ),
      )
      .selectFrom("conversations")
      .select("id")
      .where("id", "in", (q) => q.selectFrom("tree").select("id"))
      .orderBy("id")
      .forUpdate()
      .execute();
    const { orgId, rootConversationId, ...detail } = change;
    const toSeq = new Map<string, number>();
    const rootEvents = await this.events.appendIn(rootConversationId, [
      {
        type: "permission_profile_changed",
        idemKey: `permission-profile-${rootConversationId}-${change.revision}`,
        payload: detail,
      },
    ]);
    for (const event of rootEvents)
      toSeq.set(rootConversationId, Math.max(toSeq.get(rootConversationId) ?? 0, event.seq));
    await audit(this.db.db, {
      orgId,
      actorAccountId: change.actorAccountId,
      action: "conversation.permission_profile_changed",
      target: rootConversationId,
      detail: { ...detail, writer },
    });
    const cards = await this.db
      .selectFrom("approvals")
      .selectAll()
      .where("org_id", "=", orgId)
      .where(
        "conversation_id",
        "in",
        tree.map((c) => c.id),
      )
      .where("kind", "=", "command")
      .where("status", "=", "pending")
      .orderBy("conversation_id")
      .orderBy("id")
      .forUpdate()
      .execute();
    for (const card of cards) {
      await this.db
        .updateTable("approvals")
        .set({
          status: "superseded",
          superseded_revision: change.revision,
          superseded_reason: change.reason,
        })
        .where("id", "=", card.id)
        .execute();
      const cardEvents = await this.events.appendIn(card.conversation_id, [
        {
          type: "approval_decided",
          runId: card.run_id,
          idemKey: `approval_decided:${card.id}`,
          payload: {
            approvalId: card.id,
            callId: card.call_id,
            decision: "superseded",
            byAccountId: null,
            reason: change.reason,
            revision: change.revision,
          },
        },
      ]);
      for (const event of cardEvents)
        toSeq.set(card.conversation_id, Math.max(toSeq.get(card.conversation_id) ?? 0, event.seq));
    }
    await this.outbox.add({
      queue: "cap-kernel-maintenance",
      name: PERMISSION_APPROVAL_RECHECK,
      jobId: `permission-recheck-${rootConversationId}-${change.revision}`,
      data: { orgId, rootConversationId, revision: change.revision },
      orgId,
    });
    for (const [conversationId, seq] of toSeq)
      afterCommit(() => this.events.notify(conversationId, seq));
  }
}
