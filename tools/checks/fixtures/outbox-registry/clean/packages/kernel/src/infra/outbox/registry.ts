import { SUBAGENT_JOB } from "../../runtime/configured.processor.js";
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
  [SUBAGENT_JOB]: {
    queue: "cap-kernel-subagent-runs",
    idempotent: "only a queued run is started",
    processedIn: "packages/kernel/src/runtime/configured.processor.ts",
  },
} as const;
