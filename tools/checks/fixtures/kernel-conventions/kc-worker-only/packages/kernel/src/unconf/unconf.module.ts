import { Module } from "@nestjs/common";
import { ApiJob, PlainService } from "../jobs/jobs.js";
import { holder, jobs } from "./helpers.js";

declare const flag: boolean;

// imported by KernelModule: elements whose class is not visible statically (kc-wiring cannot
// confirm them either)
const BUILT = [jobs()]; // expect: kc-wiring, kc-worker-only

@Module({
  providers: [
    jobs(), // expect: kc-wiring, kc-worker-only
    flag ? ApiJob : PlainService, // expect: kc-wiring, kc-worker-only
    holder.job, // expect: kc-wiring, kc-worker-only
    { provide: "J", useClass: holder.job }, // expect: kc-wiring, kc-worker-only
    { provide: "E", useExisting: PlainService },
    ...BUILT,
  ],
})
export class UnconfModule {}

// the same shapes in a module only WorkerModule imports are fine for kc-worker-only
@Module({ providers: [jobs(), flag ? ApiJob : PlainService, holder.job] }) // expect: kc-wiring
export class WorkerUnconfModule {}
