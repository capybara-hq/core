import { type DynamicModule, Module } from "@nestjs/common";
import { CliJobsModule } from "../jobs/cli-jobs.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ScheduledJob } from "../jobs/jobs.js";
import { AliasedModule } from "../alias/alias.module.js";
import { CycleA } from "../cycle/cycle.module.js";
import { NsModule } from "../ns/ns.module.js";
import { LooseModule } from "../loose/loose.module.js";
import { SharedModule } from "../shared/shared.module.js";

@Module({})
export class WorkerModule {
  static forRoot(): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        JobsModule,
        SharedModule,
        LooseModule,
        CycleA,
        CliJobsModule,
        AliasedModule,
        NsModule,
      ],
      providers: [ScheduledJob],
    };
  }
}
