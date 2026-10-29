import { Module } from "@nestjs/common";
import { Listed, Passed, Probe, Spread } from "./probe.service.js";

// the control: each class is provided here and again in another module below
@Module({
  providers: [
    Probe, // expect: kc-wiring
    Listed, // expect: kc-wiring
    Spread, // expect: kc-wiring
    Passed, // expect: kc-wiring
  ],
})
export class AModule {}

// a subclass of a module inherits its metadata: one more instance of each provider
@Module({})
export class SubModule extends AModule {} // expect: kc-wiring
