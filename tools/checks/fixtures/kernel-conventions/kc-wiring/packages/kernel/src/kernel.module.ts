import { Module } from "@nestjs/common";
import { AgentsService } from "./agents/agents.service.js";
import { EVAL_QUOTA, HEALTH_CHECKS } from "./tokens.js";

@Module({
  providers: [
    AgentsService, // expect: kc-wiring
    { provide: "AGENTS", useFactory: () => new AgentsService() }, // expect: kc-wiring
    { provide: "OPTIONS", useValue: {} }, // expect: kc-wiring
    { provide: HEALTH_CHECKS, useFactory: () => ({}) },
    { provide: EVAL_QUOTA, useFactory: () => ({}) },
    { provide: KERNEL_APP_OPTIONS, useValue: {} },
    { provide: OTHER_QUOTA, useFactory: () => ({}) }, // expect: kc-wiring
  ],
})
export class KernelModule {}
