import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { AgentsService } from "./agents/agents.service.js";
import { EVAL_QUOTA, HEALTH_CHECKS } from "./tokens.js";

@Module({
  providers: [
    AgentsService, // expect: kc-wiring
    { provide: "AGENTS", useFactory: () => new AgentsService() }, // expect: kc-wiring
    { provide: "OPTIONS", useValue: {} }, // expect: kc-wiring
    { provide: HEALTH_CHECKS, useFactory: () => ({}) },
    { provide: EVAL_QUOTA, useFactory: () => ({}) }, // expect: kc-wiring
    { provide: KERNEL_APP_OPTIONS, useValue: {} },
    { provide: OTHER_QUOTA, useFactory: () => ({}) }, // expect: kc-wiring
  ],
})
export class KernelModule {}

// the application's own seam values: a KC_EXCEPTIONS entry (kc-wiring) for the `...overrides`
// entry of this class only
declare function makeExtra(): Provider;

@Module({})
class KernelAppOptionsModule {
  static forRoot(options: { overrides?: Provider[] }): DynamicModule {
    const overrides = options.overrides ?? [];
    return {
      module: KernelAppOptionsModule,
      providers: [
        ...overrides,
        makeExtra(), // expect: kc-wiring
      ],
    };
  }
}
