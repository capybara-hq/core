import { Inject, Injectable } from "@nestjs/common";
import { afterCommit } from "../infra/database/after-commit.js";

@Injectable()
export class AgentsService {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(LockService) private readonly lockService: LockService,
    @Inject(AgentQueue) private readonly queue: AgentQueue,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  @WithLock({ key: "agents", ttlMs: 1000 })
  @Transactional()
  async create(): Promise<void> {
    await this.db.insertInto("agents").values({}).execute();
    afterCommit(() => this.queue.add("created", {}));
  }
}
