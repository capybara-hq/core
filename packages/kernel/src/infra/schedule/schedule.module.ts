import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

/**
 * The cron scheduler (`@nestjs/schedule`). The one place that imports it: Task 4.1 moves this
 * module under the worker role, so only worker processes run `@LockedCron` jobs.
 */
@Module({ imports: [ScheduleModule.forRoot()], exports: [ScheduleModule] })
export class KernelScheduleModule {}
