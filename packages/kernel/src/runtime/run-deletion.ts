import { Inject, Injectable } from "@nestjs/common";
import { BackgroundTaskStopper } from "../background/stop.js";
import { conversationTree } from "../conversations/tree.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { RunFinish } from "./run-finish.js";
import { ACTIVE_RUN_STATUSES } from "./run-jobs.js";
import { isLive } from "./run-liveness.js";

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
    if (!org || isLive(org.deleted_at)) return;
    let after = "";
    for (;;) {
      const rows = await this.liveConversationsIn(data.orgId, after);
      for (const row of rows) {
        await this.stopConversationIn(row.id, data.byAccountId, "org_deleted");
        await this.background.stopForDeletedConversation(row.id);
      }
      if (rows.length < 100) return;
      after = rows[rows.length - 1]?.id ?? after;
    }
  }

  /**
   * One page of the org's conversations that still have live work: an active run (queued, running
   * or waiting on an open wait) or a running background task (owned by its sandbox root). Idle
   * conversations are skipped: there is nothing to stop in them.
   */
  private async liveConversationsIn(orgId: string, after: string): Promise<{ id: string }[]> {
    return this.db
      .selectFrom("conversations as c")
      .select("c.id")
      .where("c.org_id", "=", orgId)
      .where("c.kind", "in", ["chat", "subagent"])
      .where("c.id", ">", after)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom("runs as r")
              .select("r.id")
              .whereRef("r.conversation_id", "=", "c.id")
              .where("r.status", "in", ACTIVE_RUN_STATUSES),
          ),
          eb.exists(
            eb
              .selectFrom("background_tasks as b")
              .select("b.id")
              .whereRef("b.sandbox_conversation_id", "=", "c.id")
              .where("b.status", "=", "running"),
          ),
        ]),
      )
      .orderBy("c.id")
      .limit(100)
      .execute();
  }

  async stopTree(conversationId: string, byAccountId: string | null): Promise<void> {
    const root = await this.db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!root || isLive(root.deleted_at)) return;
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
    if (!deleted || isLive(deleted.conversation_deleted, deleted.org_deleted)) return;
    await this.stopConversationIn(conversationId, byAccountId);
    await this.background.stopForDeletedConversation(conversationId);
  }

  @Transactional({ propagation: "requires_new" })
  private async stopConversationIn(
    conversationId: string,
    byAccountId: string | null,
    reason: "user" | "org_deleted" = "user",
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
      .where("status", "in", ACTIVE_RUN_STATUSES)
      .orderBy("id")
      .execute();
    for (const run of runs) {
      await this.finisher.finishIn({
        conversationId,
        runId: run.id,
        status: "aborted",
        consumed: null,
        event: { type: "run_aborted", payload: { byAccountId, reason } },
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
