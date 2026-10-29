import { Module } from "@nestjs/common";
import { AliasedJob } from "../jobs/aliased.js";

// imported by WorkerModule, and by KernelModule under another name
@Module({ providers: [AliasedJob] }) // expect: kc-worker-only
export class AliasedModule {}
