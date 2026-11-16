import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFencePrelude,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { RunResume } from "../runtime/run-jobs.js";
import { PermissionAuthorityLock } from "../sandbox/permission-authority-lock.js";
export type PermissionRecheckData = { orgId: string; rootConversationId: string; revision: number };
@Injectable()
export class PermissionApprovalJobs {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(RunResume) private readonly resumes: RunResume,
  ) {}
  async recheck(data: PermissionRecheckData): Promise<void> {
    const root = await this.db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", data.rootConversationId)
      .where("org_id", "=", data.orgId)
      .executeTakeFirst();
    if (!root) return;
    await withTransactionFencePrelude(
      () =>
        this.locks.acquire(
          {
            orgId: data.orgId,
            rootConversationId: data.rootConversationId,
            ...(root.device_id ? { deviceId: root.device_id } : {}),
          },
          { kind: "admit" },
        ),
      () => this.recheckLocked(data),
    );
  }
  @Transactional()
  private async recheckLocked(data: PermissionRecheckData): Promise<void> {
    const root = await this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", data.rootConversationId)
      .where("org_id", "=", data.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!root || root.permission_revision < data.revision) return;
    const tree = await this.db
      .withRecursive("tree(id)", (db) =>
        db
          .selectFrom("conversations")
          .select("id")
          .where("id", "=", root.id)
          .unionAll((q) =>
            q
              .selectFrom("conversations as c")
              .innerJoin("tree", "tree.id", "c.parent_conversation_id")
              .select("c.id")
              .where("c.org_id", "=", data.orgId),
          ),
      )
      .selectFrom("conversations")
      .select("id")
      .where("id", "in", (q) => q.selectFrom("tree").select("id"))
      .orderBy("id")
      .forUpdate()
      .execute();
    const cards = await this.db
      .selectFrom("approvals")
      .select(["run_id", "conversation_id"])
      .where(
        "conversation_id",
        "in",
        tree.map((c) => c.id),
      )
      .where("kind", "=", "command")
      .where("status", "=", "superseded")
      .where("superseded_revision", "<=", root.permission_revision)
      .orderBy("conversation_id")
      .orderBy("run_id")
      .execute();
    for (const runId of [...new Set(cards.map((c) => c.run_id))])
      await this.resumes.resumeIn(runId, `permission-${root.id}-${root.permission_revision}`);
  }
}
