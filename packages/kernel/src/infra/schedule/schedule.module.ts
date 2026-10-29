import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { LockedIntervalScheduler } from "./locked-interval.js";
import { ScheduledRuns } from "./scheduled-runs.js";

/**
 * The cron scheduler (`@nestjs/schedule`), the `@LockedInterval` scheduler and the runs of both
 * (`ScheduledRuns`: tracked, stopped within the stop budget). The one place that
 * imports them: Task 4.1 moves this module under the worker role, so only worker processes run
 * `@LockedCron` / `@LockedInterval` jobs.
 */
@Module({
  imports: [ScheduleModule.forRoot(), DiscoveryModule],
  providers: [LockedIntervalScheduler, ScheduledRuns],
  exports: [ScheduleModule, LockedIntervalScheduler, ScheduledRuns],
})
export class KernelScheduleModule {}
