import { Inject, Injectable } from "@nestjs/common";

@Injectable()
export class RunsService {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: Bus,
    @Inject(RunQueue) private readonly runQueue: RunQueue,
  ) {}

  @Transactional()
  async start(): Promise<void> {
    await this.runQueue.add("run", {}); // expect: kc-side-effect-in-tx
    await this.redis.set("k", "v"); // expect: kc-side-effect-in-tx
    await this.bus.publish("topic", {}); // expect: kc-side-effect-in-tx
    afterCommit(async () => {
      await this.runQueue.add("run", {});
      await this.redis.del("k");
      await this.bus.publish("topic", {});
    });
  }

  async notInTx(): Promise<void> {
    await this.runQueue.add("run", {});
  }
}
