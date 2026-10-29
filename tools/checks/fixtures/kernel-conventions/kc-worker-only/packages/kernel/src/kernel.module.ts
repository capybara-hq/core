import { type DynamicModule, Module } from "@nestjs/common";
import { AliasedModule as AM } from "./alias/alias.module.js";
import { ApiModule } from "./http/api.module.js";
import * as ns from "./ns/ns.module.js";
import { OtherModule } from "./other/other.module.js";
import { WorkerModule } from "./roles/worker.module.js";
import { SharedModule } from "./shared/shared.module.js";

@Module({})
export class KernelModule {
  static forRoot(roles: string[]): DynamicModule {
    return {
      module: KernelModule,
      imports: [
        SharedModule,
        ApiModule,
        AM,
        ns.NsModule,
        OtherModule,
        ...(roles.includes("worker") ? [WorkerModule.forRoot()] : []),
      ],
    };
  }
}
