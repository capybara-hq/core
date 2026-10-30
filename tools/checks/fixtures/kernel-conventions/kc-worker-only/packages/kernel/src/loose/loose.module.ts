import { Module } from "@nestjs/common";
import { LooseJob } from "../jobs/jobs.js";

// a provider list outside any module definition: whose module it ends up in is not visible here
const LOOSE_PROVIDERS = [LooseJob]; // expect: kc-worker-only

@Module({ providers: [...LOOSE_PROVIDERS] })
export class LooseModule {}
