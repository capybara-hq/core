import { Module } from "@nestjs/common";
import { NsJob } from "../jobs/aliased.js";

// imported by WorkerModule, and by KernelModule through a namespace import
@Module({ providers: [NsJob] }) // expect: kc-worker-only
export class NsModule {}
