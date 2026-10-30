import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

/** 评测队列的 BullMQ 队列名（不含 `:`，C7）。 */
export const EVAL_QUEUE_NAME = "cap-kernel-evals";

/** 每个用例一个任务（C7；不含 `:`）。 */
export const evalJobId = (runId: string, caseId: string): string => `eval-${runId}-${caseId}`;

/** 评测任务的数据。 */
export interface EvalJobData {
  runId: string;
  caseId: string;
  orgId: string;
}

/**
 * The producer of `cap-kernel-evals` (one job per case, {@link evalJobId}); the eval worker
 * consumes it on the worker role. A leaf module: the runs service and the worker import it.
 */
@Injectable()
export class EvalJobs {
  constructor(
    @Inject(getQueueToken(EVAL_QUEUE_NAME)) private readonly queue: Pick<Queue, "addBulk">,
  ) {}

  async enqueue(jobs: EvalJobData[]): Promise<void> {
    await this.queue.addBulk(
      jobs.map((data) => ({
        name: "case",
        data,
        opts: {
          jobId: evalJobId(data.runId, data.caseId),
          // 处理函数外的暂时故障（PG / Redis）：指数退避重试，不让整个用例一次失败。
          // 结果按认领号写入，重做不会重复写结果
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 1000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      })),
    );
  }
}
