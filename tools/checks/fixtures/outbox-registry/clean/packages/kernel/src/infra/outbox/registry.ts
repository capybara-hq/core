import { WAKE_JOB } from "../../runtime/wake.job.js";

export const OUTBOX_JOBS = {
  run: {
    queue: "cap-kernel-runs",
    idempotent: "the run's state is checked when the job starts",
    processedIn: "packages/kernel/src/runtime/run.processor.ts",
  },
  [WAKE_JOB]: {
    queue: "cap-kernel-maintenance",
    idempotent: "waking an already awake run does nothing",
    processedIn: "packages/kernel/src/runtime/wake.processor.ts",
  },
} as const;
