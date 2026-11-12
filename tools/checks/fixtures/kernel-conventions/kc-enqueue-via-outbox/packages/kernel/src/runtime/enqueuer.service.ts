import { Inject, Injectable } from "@nestjs/common";
import { Queue } from "bullmq";

@Injectable()
export class Enqueuer {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(RUN_QUEUE) private readonly work: Queue,
    @Inject(RunJobs) private readonly jobs: RunJobs,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(MAINT) private readonly maintenance: Pick<Queue, "add">,
    @Inject(QUEUES) private readonly queues: Map<string, Queue>,
    @Inject(Mailer) private readonly mailer: Mailer,
  ) {}

  @Transactional()
  async owed(): Promise<void> {
    await this.outbox.add({ queue: "q", name: "run", jobId: "j", data: {} });
  }

  async afterTheTransaction(): Promise<void> {
    await this.work.add("run", {}); // expect: kc-enqueue-via-outbox
    await this.work.addBulk([]); // expect: kc-enqueue-via-outbox
    await this.maintenance.add("wake", {}); // expect: kc-enqueue-via-outbox
    await this.jobs.enqueue({ runId: "r" }, "j", "run"); // expect: kc-enqueue-via-outbox
  }

  async picked(name: string, byName: Record<string, Queue>): Promise<void> {
    await this.queues.get(name).add("run", {}); // expect: kc-enqueue-via-outbox
    const queues = byName;
    await queues[name].add("run", {}); // expect: kc-enqueue-via-outbox
  }

  tags(seen: Set<string>, queuedIds: Set<string>): void {
    seen.add("not a queue");
    // a Set whose name only starts with "queue" is not a queue
    queuedIds.add("run-1");
    // `.enqueue(` on anything but a jobs / queue facade is not a BullMQ add
    this.mailer.enqueue({ to: "a@example.com" });
  }
}
