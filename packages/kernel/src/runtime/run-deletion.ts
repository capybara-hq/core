import { Inject, Injectable } from "@nestjs/common";
import { BackgroundTaskStopper } from "../background/stop.js";
import { conversationTree } from "../conversations/tree.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { RunFinish } from "./run-finish.js";

export const STOP_DELETED_ORG_JOB = "stop-deleted-org";
export interface StopDeletedOrgData {
  orgId: string;
  byAccountId: string;
}

/** Platform-owned deletion work: it survives the org's outbox purge and process death. */
@Injectable()
export class RunDeletion {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RunFinish) private readonly finisher: RunFinish,
    @Inject(BackgroundTaskStopper) private readonly background: BackgroundTaskStopper,
  ) {}

  async stopOrg(data: StopDeletedOrgData): Promise<void> {
    const org = await this.db
      .selectFrom("orgs")
      .select("deleted_at")
      .where("id", "=", data.orgId)
      .executeTakeFirst();
    if (!org || org.deleted_at === null) return;
    let after = "";
    for (;;) {
      const rows = await this.db
        .selectFrom("conversations")
        .select("id")
        .where("org_id", "=", data.orgId)
        .where("kind", "in", ["chat", "subagent"])
        .where("id", ">", after)
        .orderBy("id")
        .limit(100)
        .execute();
      for (const row of rows) {
        await this.stopConversationIn(row.id, data.byAccountId);
        await this.background.stopForDeletedConversation(row.id);
      }
      if (rows.length < 100) return;
      after = rows[rows.length - 1]?.id ?? after;
    }
  }

  async stopTree(conversationId: string, byAccountId: string | null): Promise<void> {
    const root = await this.db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!root || root.deleted_at === null) return;
    for (const conv of await conversationTree(this.db.db, conversationId)) {
      await this.stopConversationIn(conv.id, byAccountId);
      await this.background.stopForDeletedConversation(conv.id);
    }
  }

  async stopDeletedConversation(conversationId: string, byAccountId: string | null): Promise<void> {
    const deleted = await this.db
      .selectFrom("conversations as c")
      .innerJoin("orgs as o", "o.id", "c.org_id")
      .select(["c.deleted_at as conversation_deleted", "o.deleted_at as org_deleted"])
      .where("c.id", "=", conversationId)
      .executeTakeFirst();
    if (!deleted || (deleted.conversation_deleted === null && deleted.org_deleted === null)) return;
    await this.stopConversationIn(conversationId, byAccountId);
    await this.background.stopForDeletedConversation(conversationId);
  }

  @Transactional({ propagation: "requires_new" })
  private async stopConversationIn(
    conversationId: string,
    byAccountId: string | null,
  ): Promise<void> {
    await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .forUpdate()
      .execute();
    const runs = await this.db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ["queued", "running", "waiting"])
      .orderBy("id")
      .execute();
    for (const run of runs) {
      await this.finisher.finishIn({
        conversationId,
        runId: run.id,
        status: "aborted",
        consumed: null,
        event: { type: "run_aborted", payload: { byAccountId, reason: "user" } },
      });
      // Cancellation must still be delivered after the terminal commit revoked its claim.
      await this.outbox.add({
        queue: MAINTENANCE_QUEUE_NAME,
        name: "run-stop",
        jobId: `stop-deleted-run-${run.id}`,
        data: { conversationId, runId: run.id, deleted: true },
      });
    }
  }
}
