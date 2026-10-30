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
 * The value each seam token takes. Every token is an optional provider the kernel itself never
 * provides (its consumer falls back to the production default):
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
interface KernelSeams {
  [AGENT_LOOP_FACTORY]: AgentLoopFactory;
  [RUN_HOOKS]: RunHooks;
  [EVAL_REPLAY_HOOKS]: EvalReplayHooks;
  [TOOL_PIPELINE_HOOKS]: ToolPipelineHooks;
  [BOOTSTRAP_LOCK_TTL]: number;
  [FILE_PREVIEW_TIMEOUT]: number;
  [LIST_MODELS_TIMEOUT]: number;
  [USAGE_REPORT_RETRY]: UsageReportRetry;
  [SANDBOX_LEASE_TIMINGS]: Partial<SandboxLeaseTimings>;
  [CHANNEL_WEBHOOK_TIMINGS]: Partial<ChannelWebhookTimings>;
  [EMBED_TOKEN_CLOCK]: () => number;
  [APP_INTERCEPTOR]: NestInterceptor;
}

/**
 * A seam of the kernel's own tests (`KernelAppOptions.overrides`): a value for one of the named
 * seam tokens of {@link KernelSeams}. Domain classes cannot be replaced this way. The tokens are
 * not exported from the package, and `@capybara-hq/testing`'s `startTestKernel` takes no
 * overrides (decision R22 of the Nest kernel spec).
 */
export type KernelOverride = {
  [K in keyof KernelSeams]: { provide: K; useValue: KernelSeams[K] };
}[keyof KernelSeams];

const SEAM_TOKENS = [
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
] as const satisfies readonly (keyof KernelSeams)[];

/** Compiles only while {@link SEAM_TOKENS} lists every key of {@link KernelSeams}. */
type MissingSeams = Exclude<keyof KernelSeams, (typeof SEAM_TOKENS)[number]>;
const allSeamsListed: [MissingSeams] extends [never] ? true : MissingSeams = true;
void allSeamsListed;

/** The tokens {@link KernelOverride} may name; any other token is refused when the application is built. */
export const KERNEL_OVERRIDE_TOKENS: ReadonlySet<unknown> = new Set<unknown>(SEAM_TOKENS);
