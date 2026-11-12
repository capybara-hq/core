import { Inject, Injectable } from "@nestjs/common";
import { OutboxService } from "../infra/outbox/outbox.service.js";

/** 评测队列的 BullMQ 队列名（不含 `:`，C7）。 */
export const EVAL_QUEUE_NAME = "cap-kernel-evals";

/** The one job name on {@link EVAL_QUEUE_NAME}: one case of an eval run. */
export const EVAL_CASE_JOB = "eval-case";

/** 每个用例一个任务（C7；不含 `:`）。 */
export const evalJobId = (runId: string, caseId: string): string => `eval-${runId}-${caseId}`;

/** 评测任务的数据。 */
export interface EvalJobData {
  runId: string;
  caseId: string;
  orgId: string;
}

/**
 * The producer of `cap-kernel-evals`: owes one {@link EVAL_CASE_JOB} per case (under
 * {@link evalJobId}) in the transaction that writes the run and its pending results (transactional
 * outbox spec §3), so a run never waits for jobs that were never added. The eval worker consumes
 * them on the worker role. A leaf module: the runs service and the worker import it.
 */
@Injectable()
export class EvalJobs {
  constructor(@Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">) {}

  /** Owes the case jobs in the caller's transaction (throws outside one). */
  async owe(jobs: readonly EvalJobData[]): Promise<void> {
    for (const data of jobs) {
      await this.outbox.add<EvalJobData>({
        queue: EVAL_QUEUE_NAME,
        name: EVAL_CASE_JOB,
        jobId: evalJobId(data.runId, data.caseId),
        data,
        orgId: data.orgId,
      });
    }
  }
}
