import type { NestInterceptor } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { EvalReplayHooks } from "./evals/run-replay.js";
import { EVAL_REPLAY_HOOKS } from "./evals/worker.js";
import { AGENT_LOOP_FACTORY, type AgentLoopFactory } from "./runtime/run-steps.js";
import { RUN_HOOKS, type RunHooks } from "./runtime/run-worker.js";

/**
 * A test seam of the kernel application (`KernelAppOptions.overrides`): a value for one of the
 * named seam tokens, each an optional provider the kernel itself never provides. Domain classes
 * cannot be replaced this way.
 *
 * - `AGENT_LOOP_FACTORY`: the agent loop runs execute (default the LangGraph loop);
 * - `RUN_HOOKS`: the run worker's hooks;
 * - `EVAL_REPLAY_HOOKS`: the hooks of the eval full-run replay and the judge;
 * - `APP_INTERCEPTOR`: one more global interceptor (a probe of the matched routes).
 */
export type KernelOverride =
  | { provide: typeof AGENT_LOOP_FACTORY; useValue: AgentLoopFactory }
  | { provide: typeof RUN_HOOKS; useValue: RunHooks }
  | { provide: typeof EVAL_REPLAY_HOOKS; useValue: EvalReplayHooks }
  | { provide: typeof APP_INTERCEPTOR; useValue: NestInterceptor };

/** The tokens {@link KernelOverride} may name; any other token is refused when the application is built. */
export const KERNEL_OVERRIDE_TOKENS: ReadonlySet<unknown> = new Set<unknown>([
  AGENT_LOOP_FACTORY,
  RUN_HOOKS,
  EVAL_REPLAY_HOOKS,
  APP_INTERCEPTOR,
]);
