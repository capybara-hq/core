import { Module } from "@nestjs/common";
import { CycleJob } from "../jobs/jobs.js";

// a cycle reachable only from WorkerModule is still worker-only
// CycleJob is provided by ApiModule too (as CJ): two instances
@Module({ imports: [CycleB], providers: [CycleJob] }) // expect: kc-wiring
export class CycleA {}

@Module({ imports: [CycleA] })
export class CycleB {}
