import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { LockedIntervalScheduler } from "./locked-interval.js";

/**
 * The cron scheduler (`@nestjs/schedule`) and the `@LockedInterval` scheduler. The one place that
 * imports them: Task 4.1 moves this module under the worker role, so only worker processes run
 * `@LockedCron` / `@LockedInterval` jobs.
 */
@Module({
  imports: [ScheduleModule.forRoot(), DiscoveryModule],
  providers: [LockedIntervalScheduler],
  exports: [ScheduleModule, LockedIntervalScheduler],
})
export class KernelScheduleModule {}
