import { Inject, Injectable } from "@nestjs/common";

@Injectable()
export class Waits {
  constructor(@Inject(LockService) private readonly lockService: LockService) {}

  @WithLock({ key: "waits", ttlMs: 1000 })
  async resume(): Promise<void> {}
}

@Injectable()
export class RunsService {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LockService) private readonly lockService: LockService,
    @Inject(Waits) private readonly waits: Waits,
  ) {}

  @WithLock({ key: "run", ttlMs: 1000 })
  async locked(): Promise<void> {}

  @Transactional() // expect: kc-lock-in-tx
  @WithLock({ key: "inverted", ttlMs: 1000 })
  async inverted(): Promise<void> {}

  @WithLock({ key: "right", ttlMs: 1000 })
  @Transactional()
  async rightOrder(): Promise<void> {}

  @Transactional()
  async finish(): Promise<void> {
    await this.locked(); // expect: kc-lock-in-tx
    await this.waits.resume(); // expect: kc-lock-in-tx
    await this.lockService.run("x", { ttlMs: 1000 }, async () => {}); // expect: kc-lock-in-tx
  }

  async outside(): Promise<void> {
    await this.locked();
  }
}
