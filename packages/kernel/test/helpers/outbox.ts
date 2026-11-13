import type { INestApplicationContext } from "@nestjs/common";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { OutboxDispatcher } from "../../src/infra/outbox/outbox.dispatcher.js";
import { waitFor } from "./runs.js";

/** Which owed outbox rows {@link drainOutbox} waits for (every given field must match). */
export interface OutboxFilter {
  queue?: string;
  jobName?: string;
  jobId?: string;
}

/**
 * Runs one relay pass (`OutboxDispatcher.dispatchDue`) of `app` over the due rows, then waits until
 * no owed (not dead) row matching `filter` is left. A concurrent pass (a fast path, the worker's
 * `outbox-relay` tick) holds the rows it claimed (`FOR UPDATE SKIP LOCKED`, so ours skips them)
 * and deletes them only when its claim transaction commits, after `addBulk`: the job may already
 * run (and the test see its effect) while its row is still there. Once this returns, every
 * matching row's job was added and the pass that added it committed.
 *
 * The caller first makes the rows due (and turns off any `OUTBOX_DISPATCH_FAILS` seam for them).
 */
export async function drainOutbox(
  app: Pick<INestApplicationContext, "get">,
  filter: OutboxFilter = {},
  timeoutMs = 30_000,
): Promise<void> {
  await app.get(OutboxDispatcher).dispatchDue(500);
  const db = app.get(KernelDb);
  await waitFor(
    async () => {
      let q = db.selectFrom("outbox").select("id").where("dead_at", "is", null);
      if (filter.queue !== undefined) q = q.where("queue", "=", filter.queue);
      if (filter.jobName !== undefined) q = q.where("job_name", "=", filter.jobName);
      if (filter.jobId !== undefined) q = q.where("job_id", "=", filter.jobId);
      return (await q.limit(1).execute()).length === 0;
    },
    timeoutMs,
    `the owed outbox rows ${JSON.stringify(filter)} delivered`,
  );
}
