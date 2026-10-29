import { Module } from "@nestjs/common";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { NestedJob, QueueProcessor } from "./jobs.js";

// only WorkerModule imports it, and through it NestedModule
@Module({ providers: [NestedJob], exports: [NestedJob] })
export class NestedModule {}

@Module({
  imports: [NestedModule],
  providers: [configuredProcessor(QueueProcessor, "queue", {})],
  exports: [NestedModule, QueueProcessor],
})
export class JobsModule {}
