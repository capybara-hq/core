export const SUBAGENT_JOB = "subagent";

export class SubagentProcessor {
  async process(job: { name: typeof SUBAGENT_JOB }) {
    return job.name;
  }
}

export const providers = [configuredProcessor(SubagentProcessor, "cap-kernel-subagent-runs", {})];
