import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { Jobs } from "./aa/index.js";
import { AliasedModule as AM } from "./alias/alias.module.js";
import D from "./defaults/index.js";
import { ApiModule } from "./http/api.module.js";
import * as ns from "./ns/ns.module.js";
import { OtherModule } from "./other/other.module.js";
import { WorkerModule } from "./roles/worker.module.js";
import { SharedModule } from "./shared/shared.module.js";
import { UnconfModule } from "./unconf/unconf.module.js";
import { Kit } from "./yy/index.js";

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
        Jobs,
        Kit,
        D,
        UnconfModule,
        KernelAppOptionsModule.forRoot({}),
        ...(roles.includes("worker") ? [WorkerModule.forRoot()] : []),
      ],
    };
  }
}

// the application's own seam values: a KC_EXCEPTIONS entry (kc-worker-only) for the
// `...overrides` entry of this class only; kc-wiring's entry is not applied to this fixture
declare function makeExtra(): Provider;

@Module({})
class KernelAppOptionsModule {
  static forRoot(options: { overrides?: Provider[] }): DynamicModule {
    const overrides = options.overrides ?? []; // expect: kc-wiring
    return {
      module: KernelAppOptionsModule,
      providers: [
        ...overrides,
        makeExtra(), // expect: kc-wiring, kc-worker-only
      ],
    };
  }
}
