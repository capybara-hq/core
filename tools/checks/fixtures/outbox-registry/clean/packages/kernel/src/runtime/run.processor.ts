@Processor("cap-kernel-runs")
export class RunProcessor {
  async process(job: { name: string }) {
    if (job.name === "run") return;
  }
}
