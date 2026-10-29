import type { NestInterceptor } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { CHANNEL_WEBHOOK_TIMINGS, type ChannelWebhookTimings } from "./channels/webhook.js";
import type { EvalReplayHooks } from "./evals/run-replay.js";
import { EVAL_REPLAY_HOOKS } from "./evals/worker.js";
import { BOOTSTRAP_LOCK_TTL } from "./extensions/bootstrap.js";
import { FILE_PREVIEW_TIMEOUT } from "./files/previewers.js";
import { LIST_MODELS_TIMEOUT } from "./runtime/providers.js";
import { AGENT_LOOP_FACTORY, type AgentLoopFactory } from "./runtime/run-steps.js";
import { RUN_HOOKS, type RunHooks } from "./runtime/run-worker.js";
import { USAGE_REPORT_RETRY, type UsageReportRetry } from "./runtime/usage-report.js";
import { SANDBOX_LEASE_TIMINGS, type SandboxLeaseTimings } from "./sandbox/leases.js";
import { TOOL_PIPELINE_HOOKS, type ToolPipelineHooks } from "./tools/pipeline.js";
import { EMBED_TOKEN_CLOCK } from "./ui/embed-token.js";

/**
 * A test seam of the kernel application (`KernelAppOptions.overrides`): a value for one of the
 * named seam tokens, each an optional provider the kernel itself never provides (its consumer
 * falls back to the production default). Domain classes cannot be replaced this way.
 *
 * - `AGENT_LOOP_FACTORY`: the agent loop runs execute (default the LangGraph loop);
 * - `RUN_HOOKS`: the run worker's hooks;
 * - `EVAL_REPLAY_HOOKS`: the hooks of the eval full-run replay and the judge;
 * - `TOOL_PIPELINE_HOOKS`: the tool pipeline's hooks and policy decision;
 * - `BOOTSTRAP_LOCK_TTL`, `FILE_PREVIEW_TIMEOUT`, `LIST_MODELS_TIMEOUT`, `USAGE_REPORT_RETRY`,
 *   `SANDBOX_LEASE_TIMINGS`, `CHANNEL_WEBHOOK_TIMINGS`: shorter timings;
 * - `EMBED_TOKEN_CLOCK`: the clock embed tokens are issued and checked with;
 * - `APP_INTERCEPTOR`: one more global interceptor (a probe of the matched routes).
 */
export type KernelOverride =
  | { provide: typeof AGENT_LOOP_FACTORY; useValue: AgentLoopFactory }
  | { provide: typeof RUN_HOOKS; useValue: RunHooks }
  | { provide: typeof EVAL_REPLAY_HOOKS; useValue: EvalReplayHooks }
  | { provide: typeof TOOL_PIPELINE_HOOKS; useValue: ToolPipelineHooks }
  | { provide: typeof BOOTSTRAP_LOCK_TTL; useValue: number }
  | { provide: typeof FILE_PREVIEW_TIMEOUT; useValue: number }
  | { provide: typeof LIST_MODELS_TIMEOUT; useValue: number }
  | { provide: typeof USAGE_REPORT_RETRY; useValue: UsageReportRetry }
  | { provide: typeof SANDBOX_LEASE_TIMINGS; useValue: Partial<SandboxLeaseTimings> }
  | { provide: typeof CHANNEL_WEBHOOK_TIMINGS; useValue: Partial<ChannelWebhookTimings> }
  | { provide: typeof EMBED_TOKEN_CLOCK; useValue: () => number }
  | { provide: typeof APP_INTERCEPTOR; useValue: NestInterceptor };

/** The tokens {@link KernelOverride} may name; any other token is refused when the application is built. */
export const KERNEL_OVERRIDE_TOKENS: ReadonlySet<unknown> = new Set<unknown>([
  AGENT_LOOP_FACTORY,
  RUN_HOOKS,
  EVAL_REPLAY_HOOKS,
  TOOL_PIPELINE_HOOKS,
  BOOTSTRAP_LOCK_TTL,
  FILE_PREVIEW_TIMEOUT,
  LIST_MODELS_TIMEOUT,
  USAGE_REPORT_RETRY,
  SANDBOX_LEASE_TIMINGS,
  CHANNEL_WEBHOOK_TIMINGS,
  EMBED_TOKEN_CLOCK,
  APP_INTERCEPTOR,
]);
