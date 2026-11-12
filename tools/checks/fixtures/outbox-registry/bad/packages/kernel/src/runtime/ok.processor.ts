@Processor("q")
export class Ok {
  async process(job: { name: string }) {
    if (job.name === "fine" || job.name === "noIdempotent") return;
  }
}
