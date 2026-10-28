import { Inject, Injectable } from "@nestjs/common";
import { Cron, Interval, Timeout } from "@nestjs/schedule";

@Injectable()
export class Maintenance {
  constructor(
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: Logger,
  ) {}

  @Cron("0 * * * *") // expect: kc-cron
  hourly() {}

  @Interval(60_000) // expect: kc-cron
  everyMinute() {}

  @Timeout(1000) // expect: kc-cron
  once() {}

  @LockedCron("0 * * * *", { key: "sweep", ttlMs: 60_000 })
  sweep() {}
}
