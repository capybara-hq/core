import { Module } from "@nestjs/common";
import { Probe as Bar } from "./probe.service.js";

// an aliased import
@Module({ providers: [Bar] }) // expect: kc-wiring
export class BModule {}
