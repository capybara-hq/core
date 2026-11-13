export const WAKE_JOB = "bg-wake";
export const MAINTENANCE = "cap-kernel-maintenance";

@Processor("cap-kernel-maintenance")
export class WakeProcessor {
  process(job: { name: string }) {
    return job.name === "run" || job.name === WAKE_JOB;
  }
}
