import { Module } from "@nestjs/common";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { ApiJob, ApiProcessor } from "../jobs/jobs.js";

@Module({
  providers: [
    ApiJob, // expect: kc-worker-only
    configuredProcessor(ApiProcessor, "api", {}), // expect: kc-worker-only
  ],
})
export class ApiModule {}
