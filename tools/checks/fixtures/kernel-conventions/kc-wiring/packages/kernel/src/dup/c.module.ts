import { Module } from "@nestjs/common";
import { Listed } from "./probe.service.js";

// a same-file const list
const PROVIDERS = [Listed]; // expect: kc-wiring

@Module({ providers: PROVIDERS })
export class CModule {}
