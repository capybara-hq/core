import { type DynamicModule, Module } from "@nestjs/common";
import { EVAL_QUOTA, RUN_QUOTA } from "../tokens.js";
import { EventLog } from "./event-log.js";

export const runtime = (): DynamicModule => ({
  module: RuntimeModule,
  providers: [{ provide: "LOG", useClass: EventLog }], // expect: kc-wiring
});

// the allowed factory tokens, each in its own module
@Module({
  providers: [
    { provide: RUN_QUOTA, useFactory: () => ({}) },
    { provide: EVAL_QUOTA, useFactory: () => ({}) },
  ],
})
export class QuotaModule {}
