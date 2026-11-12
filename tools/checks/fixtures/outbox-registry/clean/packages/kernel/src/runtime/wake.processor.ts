import { WAKE_JOB } from "./wake.job.js";

@Processor("cap-kernel-maintenance")
export class WakeProcessor {
  async process(job: { name: string }) {
    if (job.name === WAKE_JOB) return;
  }
}
