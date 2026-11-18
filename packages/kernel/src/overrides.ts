import type { NestInterceptor } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ADMIN_USAGE_TIMINGS, type AdminUsageTimings } from "./admin/usage.service.js";
import { SCOPE_ORG_CHUNK_SIZE } from "./catalog/scope-jobs.js";
import { CHANNEL_WEBHOOK_TIMINGS, type ChannelWebhookTimings } from "./channels/webhook.js";
import { EXTENSION_NET_SEAMS, type ExtensionNetSeams } from "./ctx/net.js";
import type { EvalReplayHooks } from "./evals/run-replay.js";
import { EVAL_REPLAY_HOOKS } from "./evals/worker.js";
import { BOOTSTRAP_LOCK_TTL } from "./extensions/bootstrap.js";
import { USAGE_SUBSCRIBERS_CLOCK } from "./extensions/usage-subscribers.js";
import { FILE_PREVIEW_TIMEOUT } from "./files/previewers.js";
import { GIT_UPSTREAM_ORIGIN, type GitUpstreamOrigin } from "./git/gateway.js";
import { GIT_IDENTITY_API_BASE, type GitIdentityApiBase } from "./git/identity.js";
import { HTML_TOKEN_CLOCK } from "./html/html-token.js";
import { PLUGIN_PUBLIC_WRITE_LIMIT } from "./http/plugin-route-access.js";
import { OUTBOX_DISPATCH_FAILS } from "./infra/outbox/outbox.dispatcher.js";
import { OUTBOX_FAST_PATH_SETTLED } from "./infra/outbox/outbox.module.js";
import { PRESENCE_INTERVAL_MS } from "./infra/presence/replica-presence.js";
import type { KernelQueueName } from "./infra/queue/queue-names.js";
import { DEVICE_POLICY_AFTER_CALL } from "./local-devices/device-policy.service.js";
import { PROJECT_KNOWLEDGE_TIMEOUT } from "./runtime/project/knowledge.service.js";
import { LIST_MODELS_TIMEOUT } from "./runtime/providers.js";
import { RUN_CONTEXT_CLOCK } from "./runtime/run-context.service.js";
import { ENSURE_RUN_FAILS } from "./runtime/run-queue.js";
import { AGENT_LOOP_FACTORY, type AgentLoopFactory } from "./runtime/run-steps.js";
import { RUN_HOOKS, type RunHooks } from "./runtime/run-worker.js";
import {
  SUBAGENT_MESSAGES_HOOKS,
  type SubagentMessagesHooks,
} from "./runtime/subagents/messages.js";
import { SANDBOX_LEASE_TIMINGS, type SandboxLeaseTimings } from "./sandbox/leases.js";
import { PERMISSION_CONTEXT_ACTIVATION } from "./sandbox/permission-context-types.js";
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
 * - `BOOTSTRAP_LOCK_TTL`, `FILE_PREVIEW_TIMEOUT`, `LIST_MODELS_TIMEOUT`,
 *   `SANDBOX_LEASE_TIMINGS`, `CHANNEL_WEBHOOK_TIMINGS`, `SETUP_CHECK_TIMEOUT`,
 *   `PRESENCE_INTERVAL_MS`: shorter timings;
 * - `ADMIN_USAGE_TIMINGS`: the usage aggregate's statement timeout and clock;
 * - `EMBED_TOKEN_CLOCK`: the clock embed tokens are issued and checked with;
 * - `HTML_TOKEN_CLOCK`: the clock HTML document tokens are issued and checked with;
 * - `RUN_CONTEXT_CLOCK`: the clock run start reads the run context's date from, and the
 *   `CurrentTime` builtin the time;
 * - `GIT_IDENTITY_API_BASE`: the API base of a git host for the commit identity (a loopback fake);
 * - `GIT_UPSTREAM_ORIGIN`: the origin the git gateway relays a git host to (a loopback fake);
 * - `OUTBOX_DISPATCH_FAILS`: returns true to make the outbox dispatcher's adds to the given queue
 *   fail (a Redis outage);
 * - `USAGE_SUBSCRIBERS_CLOCK`: the clock the `usage.report` subscriber cache ages with;
 * - `OUTBOX_FAST_PATH_SETTLED`: receives each detached outbox fast-path pass (a test awaits them);
 * - `ENSURE_RUN_FAILS`: returns true to make `RunQueue.ensureRun` throw (Redis unreachable, or the
 *   direct call after a commit skipped by a crash);
 * - `DEVICE_POLICY_AFTER_CALL`: called after a device policy op's call, before its outcome is
 *   recorded (throwing stands for a crash between the call and the resolve transaction);
 * - `PROJECT_KNOWLEDGE_TIMEOUT`: the run-start read of a bound project's time limit, read at every
 *   read (a test shortens it for one run);
 * - `PLUGIN_PUBLIC_WRITE_LIMIT`: a lower limit for unsafe methods on `public` extension routes;
 * - `SCOPE_ORG_CHUNK_SIZE`: fewer orgs per plugin scope sync chunk job (several chunks in a test);
 * - `EXTENSION_NET_SEAMS`: `ctx.net`'s DNS and dispatcher (a hostname resolving to a private address
 *   served by a loopback fake);
 * - `APP_INTERCEPTOR`: one more global interceptor (a probe of the matched routes);
 * - `PERMISSION_CONTEXT_ACTIVATION`: turns the dormant recorded permission context producers on
 *   (the request boundary and the managed device context writer) before their paired activation
 *   flips the production default.
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
  [SANDBOX_LEASE_TIMINGS]: Partial<SandboxLeaseTimings>;
  [CHANNEL_WEBHOOK_TIMINGS]: Partial<ChannelWebhookTimings>;
  [SETUP_CHECK_TIMEOUT]: number;
  [PRESENCE_INTERVAL_MS]: number;
  [ADMIN_USAGE_TIMINGS]: Partial<AdminUsageTimings>;
  [EMBED_TOKEN_CLOCK]: () => number;
  [HTML_TOKEN_CLOCK]: () => number;
  [RUN_CONTEXT_CLOCK]: () => number;
  [GIT_IDENTITY_API_BASE]: GitIdentityApiBase;
  [GIT_UPSTREAM_ORIGIN]: GitUpstreamOrigin;
  [OUTBOX_DISPATCH_FAILS]: (queue: KernelQueueName) => boolean;
  [USAGE_SUBSCRIBERS_CLOCK]: () => number;
  [OUTBOX_FAST_PATH_SETTLED]: (pass: Promise<void>) => void;
  [ENSURE_RUN_FAILS]: () => boolean;
  [SCOPE_ORG_CHUNK_SIZE]: number;
  [PROJECT_KNOWLEDGE_TIMEOUT]: () => number;
  [PLUGIN_PUBLIC_WRITE_LIMIT]: number;
  [DEVICE_POLICY_AFTER_CALL]: (opId: string) => void;
  [EXTENSION_NET_SEAMS]: ExtensionNetSeams;
  [APP_INTERCEPTOR]: NestInterceptor;
  [PERMISSION_CONTEXT_ACTIVATION]: boolean;
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
  USAGE_SUBSCRIBERS_CLOCK,
  SANDBOX_LEASE_TIMINGS,
  CHANNEL_WEBHOOK_TIMINGS,
  SETUP_CHECK_TIMEOUT,
  PRESENCE_INTERVAL_MS,
  ADMIN_USAGE_TIMINGS,
  EMBED_TOKEN_CLOCK,
  HTML_TOKEN_CLOCK,
  RUN_CONTEXT_CLOCK,
  GIT_IDENTITY_API_BASE,
  GIT_UPSTREAM_ORIGIN,
  OUTBOX_DISPATCH_FAILS,
  OUTBOX_FAST_PATH_SETTLED,
  ENSURE_RUN_FAILS,
  SCOPE_ORG_CHUNK_SIZE,
  PROJECT_KNOWLEDGE_TIMEOUT,
  PLUGIN_PUBLIC_WRITE_LIMIT,
  DEVICE_POLICY_AFTER_CALL,
  EXTENSION_NET_SEAMS,
  APP_INTERCEPTOR,
  PERMISSION_CONTEXT_ACTIVATION,
] as const satisfies readonly (keyof KernelSeams)[];

/** Compiles only while {@link SEAM_TOKENS} lists every key of {@link KernelSeams}. */
type MissingSeams = Exclude<keyof KernelSeams, (typeof SEAM_TOKENS)[number]>;
const allSeamsListed: [MissingSeams] extends [never] ? true : MissingSeams = true;
void allSeamsListed;

/** The tokens {@link KernelOverride} may name; any other token is refused when the application is built. */
export const KERNEL_OVERRIDE_TOKENS: ReadonlySet<unknown> = new Set<unknown>(SEAM_TOKENS);
