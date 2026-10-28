import { Inject, Injectable } from "@nestjs/common";

@Injectable()
export class MembersService {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Transactional() // expect: kc-decorator-host
  async add(): Promise<void> {}

  @WithLock({ key: "m", ttlMs: 1000 }) // expect: kc-decorator-host
  async sweep(): Promise<void> {}

  @Cacheable({ key: "m" }) // expect: kc-decorator-host
  async list(): Promise<string[]> {
    return [];
  }

  @LockedCron("* * * * *", { key: "c", ttlMs: 1000 }) // expect: kc-decorator-host
  async cron(): Promise<void> {}
}

@Injectable()
export class HostedService {
  private readonly cacheService = new Map();
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LockService) private readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  @Transactional()
  async add(): Promise<void> {}

  @LockedCron("* * * * *", { key: "c", ttlMs: 1000 })
  async cron(): Promise<void> {}

  @CacheEvict({ key: "m" })
  async evict(): Promise<void> {}
}
