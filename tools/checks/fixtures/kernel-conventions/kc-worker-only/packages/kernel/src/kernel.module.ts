import { type DynamicModule, Module } from "@nestjs/common";
import { ApiModule } from "./http/api.module.js";
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
        ...(roles.includes("worker") ? [WorkerModule.forRoot()] : []),
      ],
    };
  }
}
