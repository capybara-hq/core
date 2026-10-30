import { Module } from "@nestjs/common";
import { DecoratedProcessor } from "./jobs.js";

// imported by WorkerModule, but a CLI command builds a context with it too
@Module({ providers: [DecoratedProcessor] }) // expect: kc-worker-only
export class CliJobsModule {}
