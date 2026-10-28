import { Module } from "@nestjs/common";
import { AgentsService } from "./agents/agents.service.js";
import { EVAL_QUOTA, HEALTH_CHECKS } from "./tokens.js";

@Module({
  providers: [
    AgentsService,
    { provide: "AGENTS", useFactory: () => new AgentsService() }, // expect: kc-wiring
    { provide: "OPTIONS", useValue: {} }, // expect: kc-wiring
    { provide: HEALTH_CHECKS, useFactory: () => ({}) },
    { provide: EVAL_QUOTA, useFactory: () => ({}) },
  ],
})
export class KernelModule {}
