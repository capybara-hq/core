import type { NestInterceptor } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ADMIN_USAGE_TIMINGS, type AdminUsageTimings } from "./admin/usage.service.js";
import { CHANNEL_WEBHOOK_TIMINGS, type ChannelWebhookTimings } from "./channels/webhook.js";
import type { EvalReplayHooks } from "./evals/run-replay.js";
import { EVAL_REPLAY_HOOKS } from "./evals/worker.js";
import { BOOTSTRAP_LOCK_TTL } from "./extensions/bootstrap.js";
import { FILE_PREVIEW_TIMEOUT } from "./files/previewers.js";
import { OUTBOX_DISPATCH_FAILS } from "./infra/outbox/outbox.dispatcher.js";
import { OUTBOX_FAST_PATH_SETTLED } from "./infra/outbox/outbox.module.js";
import { OUTBOX_STRICT_CONFLICTS } from "./infra/outbox/outbox.service.js";
import { PRESENCE_INTERVAL_MS } from "./infra/presence/replica-presence.js";
import { LIST_MODELS_TIMEOUT } from "./runtime/providers.js";
import { RUN_CONTEXT_CLOCK } from "./runtime/run-context.service.js";
import { ENSURE_RUN_FAILS } from "./runtime/run-queue.js";
import { AGENT_LOOP_FACTORY, type AgentLoopFactory } from "./runtime/run-steps.js";
import { RUN_HOOKS, type RunHooks } from "./runtime/run-worker.js";
import {
  SUBAGENT_MESSAGES_HOOKS,
  type SubagentMessagesHooks,
} from "./runtime/subagents/messages.js";
import { USAGE_REPORT_RETRY, type UsageReportRetry } from "./runtime/usage-report.js";
import { SANDBOX_LEASE_TIMINGS, type SandboxLeaseTimings } from "./sandbox/leases.js";
import { SETUP_CHECK_TIMEOUT } from "./setup/setup-checks.service.js";
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
 * - `SUBAGENT_MESSAGES_HOOKS`: the sub-agent message tools' hooks (a send raced by a run's end);
 * - `BOOTSTRAP_LOCK_TTL`, `FILE_PREVIEW_TIMEOUT`, `LIST_MODELS_TIMEOUT`, `USAGE_REPORT_RETRY`,
 *   `SANDBOX_LEASE_TIMINGS`, `CHANNEL_WEBHOOK_TIMINGS`, `SETUP_CHECK_TIMEOUT`,
 *   `PRESENCE_INTERVAL_MS`: shorter timings;
 * - `ADMIN_USAGE_TIMINGS`: the usage aggregate's statement timeout and clock;
 * - `EMBED_TOKEN_CLOCK`: the clock embed tokens are issued and checked with;
 * - `RUN_CONTEXT_CLOCK`: the clock run start reads the run context's date from, and the
 *   `CurrentTime` builtin the time;
 * - `OUTBOX_STRICT_CONFLICTS`: a reused outbox job id with different data throws (tests) instead
 *   of logging an error;
 * - `OUTBOX_DISPATCH_FAILS`: returns true to make the outbox dispatcher's queue adds fail (a Redis
 *   outage);
 * - `OUTBOX_FAST_PATH_SETTLED`: receives each detached outbox fast-path pass (a test awaits them);
 * - `ENSURE_RUN_FAILS`: returns true to make `RunQueue.ensureRun` throw (Redis unreachable, or the
 *   direct call after a commit skipped by a crash);
 * - `APP_INTERCEPTOR`: one more global interceptor (a probe of the matched routes).
 */
interface KernelSeams {
  [AGENT_LOOP_FACTORY]: AgentLoopFactory;
  [RUN_HOOKS]: RunHooks;
  [EVAL_REPLAY_HOOKS]: EvalReplayHooks;
  [TOOL_PIPELINE_HOOKS]: ToolPipelineHooks;
  [SUBAGENT_MESSAGES_HOOKS]: SubagentMessagesHooks;
  [BOOTSTRAP_LOCK_TTL]: number;
  [FILE_PREVIEW_TIMEOUT]: number;
  [LIST_MODELS_TIMEOUT]: number;
  [USAGE_REPORT_RETRY]: UsageReportRetry;
  [SANDBOX_LEASE_TIMINGS]: Partial<SandboxLeaseTimings>;
  [CHANNEL_WEBHOOK_TIMINGS]: Partial<ChannelWebhookTimings>;
  [SETUP_CHECK_TIMEOUT]: number;
  [PRESENCE_INTERVAL_MS]: number;
  [ADMIN_USAGE_TIMINGS]: Partial<AdminUsageTimings>;
  [EMBED_TOKEN_CLOCK]: () => number;
  [RUN_CONTEXT_CLOCK]: () => number;
  [OUTBOX_STRICT_CONFLICTS]: boolean;
  [OUTBOX_DISPATCH_FAILS]: () => boolean;
  [OUTBOX_FAST_PATH_SETTLED]: (pass: Promise<void>) => void;
  [ENSURE_RUN_FAILS]: () => boolean;
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
  SUBAGENT_MESSAGES_HOOKS,
  BOOTSTRAP_LOCK_TTL,
  FILE_PREVIEW_TIMEOUT,
  LIST_MODELS_TIMEOUT,
  USAGE_REPORT_RETRY,
  SANDBOX_LEASE_TIMINGS,
  CHANNEL_WEBHOOK_TIMINGS,
  SETUP_CHECK_TIMEOUT,
  PRESENCE_INTERVAL_MS,
  ADMIN_USAGE_TIMINGS,
  EMBED_TOKEN_CLOCK,
  RUN_CONTEXT_CLOCK,
  OUTBOX_STRICT_CONFLICTS,
  OUTBOX_DISPATCH_FAILS,
  OUTBOX_FAST_PATH_SETTLED,
  ENSURE_RUN_FAILS,
  APP_INTERCEPTOR,
] as const satisfies readonly (keyof KernelSeams)[];

/** Compiles only while {@link SEAM_TOKENS} lists every key of {@link KernelSeams}. */
type MissingSeams = Exclude<keyof KernelSeams, (typeof SEAM_TOKENS)[number]>;
const allSeamsListed: [MissingSeams] extends [never] ? true : MissingSeams = true;
void allSeamsListed;

/** The tokens {@link KernelOverride} may name; any other token is refused when the application is built. */
export const KERNEL_OVERRIDE_TOKENS: ReadonlySet<unknown> = new Set<unknown>(SEAM_TOKENS);
