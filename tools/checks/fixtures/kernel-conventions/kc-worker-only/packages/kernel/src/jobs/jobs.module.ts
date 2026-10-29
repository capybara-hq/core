import { Module } from "@nestjs/common";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { NestedJob, QueueProcessor } from "./jobs.js";

// WorkerModule imports it through JobsModule, but KernelModule reaches it through a barrel alias
@Module({ providers: [NestedJob], exports: [NestedJob] }) // expect: kc-worker-only
export class NestedModule {}

@Module({
  imports: [NestedModule],
  providers: [configuredProcessor(QueueProcessor, "queue", {})],
  exports: [NestedModule, QueueProcessor],
})
export class JobsModule {}
