import { Module, type Provider } from "@nestjs/common";
import { AngleJob, AsJob, BangJob, CastClassJob, ParenJob } from "../jobs/cast.js";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { AliasCronJob, AliasProcessor } from "../jobs/aliased.js";
import { DirectCron, DirectProcessor } from "../jobs/direct.js";
import { ApiJob, ApiProcessor, CycleJob as CJ } from "../jobs/jobs.js";
import {
  ReflectProcessor,
  SubCron,
  SubProcessor,
  SubSubCron,
  VarCron,
  VarProcessor,
} from "../jobs/inherit.js";

@Module({
  providers: [
    ApiJob, // expect: kc-worker-only
    configuredProcessor(ApiProcessor, "api", {}), // expect: kc-worker-only
    CJ, // expect: kc-wiring, kc-worker-only
    AliasCronJob, // expect: kc-worker-only
    AliasProcessor, // expect: kc-worker-only
    DirectProcessor, // expect: kc-worker-only
    DirectCron, // expect: kc-worker-only
    SubProcessor, // expect: kc-worker-only
    SubCron, // expect: kc-worker-only
    SubSubCron, // expect: kc-worker-only
    VarProcessor, // expect: kc-worker-only
    VarCron, // expect: kc-worker-only
    ReflectProcessor, // expect: kc-worker-only
    AsJob as Provider, // expect: kc-worker-only
    <Provider>AngleJob, // expect: kc-worker-only
    BangJob!, // expect: kc-worker-only
    (ParenJob), // expect: kc-worker-only
    { provide: "C", useClass: CastClassJob as any }, // expect: kc-worker-only
  ],
})
export class ApiModule {}
