import { Module } from "@nestjs/common";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { AliasCronJob, AliasProcessor } from "../jobs/aliased.js";
import { DirectCron, DirectProcessor } from "../jobs/direct.js";
import { ApiJob, ApiProcessor, CycleJob as CJ } from "../jobs/jobs.js";

@Module({
  providers: [
    ApiJob, // expect: kc-worker-only
    configuredProcessor(ApiProcessor, "api", {}), // expect: kc-worker-only
    CJ, // expect: kc-worker-only
    AliasCronJob, // expect: kc-worker-only
    AliasProcessor, // expect: kc-worker-only
    DirectProcessor, // expect: kc-worker-only
    DirectCron, // expect: kc-worker-only
  ],
})
export class ApiModule {}
