import { Inject, Injectable } from "@nestjs/common";
import { afterCommit } from "../infra/database/after-commit.js";

@Injectable()
export class AgentsService {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(LockService) private readonly lockService: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  @WithLock({ key: "agents", ttlMs: 1000 })
  @Transactional()
  async create(): Promise<void> {
    await this.db.insertInto("agents").values({}).execute();
    await this.outbox.add({ queue: "q", name: "created", jobId: "j", data: {} });
    afterCommit(() => this.config.get());
  }
}
