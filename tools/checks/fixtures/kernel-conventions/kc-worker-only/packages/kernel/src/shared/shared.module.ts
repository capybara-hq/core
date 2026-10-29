import { Module } from "@nestjs/common";
import { PlainService, SharedJob } from "../jobs/jobs.js";

// imported by WorkerModule and by KernelModule: every role gets it
@Module({
  providers: [
    PlainService,
    SharedJob, // expect: kc-worker-only
  ],
  exports: [PlainService],
})
export class SharedModule {}
