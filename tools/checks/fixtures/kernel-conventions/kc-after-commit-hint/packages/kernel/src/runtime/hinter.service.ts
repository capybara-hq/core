import { Inject, Injectable } from "@nestjs/common";

@Injectable()
export class Hinter {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(RunQueue) private readonly runQueue: RunQueue,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  @Transactional()
  async write(): Promise<void> {
    afterCommit(async () => {
      await this.runQueue.add("run", {}); // expect: kc-enqueue-via-outbox, kc-after-commit-hint
    });
    afterCommit(() => this.outbox.add({ queue: "q", name: "run", jobId: "j", data: {} }));
    afterCommit(() => this.cache.drop());
  }
}
