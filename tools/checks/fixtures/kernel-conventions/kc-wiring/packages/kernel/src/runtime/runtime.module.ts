import type { DynamicModule } from "@nestjs/common";
import { EventLog } from "./event-log.js";

export const runtime = (): DynamicModule => ({
  module: RuntimeModule,
  providers: [{ provide: "LOG", useClass: EventLog }], // expect: kc-wiring
});
