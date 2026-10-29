import { Module } from "@nestjs/common";
import { SHARED_PROVIDERS, Spread } from "./probe.service.js";

// a spread of a same-file const list, and of a list imported from another file
const BASE = [Spread]; // expect: kc-wiring

@Module({ providers: [...BASE, ...SHARED_PROVIDERS] })
export class DModule {}

@Module({ providers: SHARED_PROVIDERS })
export class D2Module {}
