import { Module } from "@nestjs/common";
import { CycleJob } from "../jobs/jobs.js";

// a cycle reachable only from WorkerModule is still worker-only
@Module({ imports: [CycleB], providers: [CycleJob] })
export class CycleA {}

@Module({ imports: [CycleA] })
export class CycleB {}
