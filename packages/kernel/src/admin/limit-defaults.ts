import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { SubagentLimits } from "../runtime/subagents/limits.js";

/**
 * The deployment's defaults of the per-org limits (with `GET /api/v1/admin/orgs`): what an
 * organization without an override gets, from the live config. `subagents.maxDispatchesPerRun` and
 * `maxTokensPerRun` of 0 mean no limit.
 */
export interface LimitDefaults {
  /** `runtime.orgConcurrency`. */
  runConcurrency: number;
  /** `sandbox.limits.cpu` / `memoryMb`. */
  sandbox: { cpu: number; memoryMb: number };
  /** `subagents.*`. */
  subagents: SubagentLimits;
}

/** {@link LimitDefaults} from the live config. */
export function limitDefaults(config: KernelConfigService): LimitDefaults {
  const cfg = config.get();
  const { maxDepth, maxConcurrentPerConversation, maxDispatchesPerRun, maxTokensPerRun } =
    cfg.subagents;
  return {
    runConcurrency: cfg.runtime.orgConcurrency,
    sandbox: { cpu: cfg.sandbox.limits.cpu, memoryMb: cfg.sandbox.limits.memoryMb },
    subagents: { maxDepth, maxConcurrentPerConversation, maxDispatchesPerRun, maxTokensPerRun },
  };
}
