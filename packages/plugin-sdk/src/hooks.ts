import type { ContentBlock, ModelRequest, ModelUsage } from "./model.js";

/**
 * Hook mount points a plugin can register on through `ctx.hooks.on` (from M7). The other names in
 * `HOOK_MOUNT_POINTS` (`session.*`, `agent.preStep`) stay reserved: they validate in a manifest but
 * cannot be registered yet.
 */
export const HOOKS_AVAILABLE = [
  "model.request",
  "model.response",
  "tool.preExecute",
  "tool.postExecute",
  "usage.report",
] as const;

/** A mount point that `ctx.hooks.on` accepts. */
export type AvailableHook = (typeof HOOKS_AVAILABLE)[number];

/** Who and where a model or tool hook fires for. Hooks fire only in chat conversations. */
export interface HookScope {
  orgId: string;
  accountId: string;
  agentId: string;
  agentVersion: number;
  conversationId: string;
  runId: string;
}

/** `model.request`: before a model call is sent (once per attempt). A policy hook may deny it. */
export interface ModelRequestHookPayload extends HookScope {
  step: number;
  attempt: number;
  provider: string;
  model: string;
  request: Readonly<ModelRequest>;
}

/** `model.response`: after a model call finished or failed, with its usage when known. */
export interface ModelResponseHookPayload extends HookScope {
  step: number;
  attempt: number;
  provider: string;
  model: string;
  outcome: "ok" | "failed";
  content: readonly ContentBlock[];
  stopReason: string | null;
  usage: ModelUsage | null;
  latencyMs: number;
  errorCode?: string;
}

/** `tool.preExecute`: before a tool call runs. A policy hook may deny it. */
export interface ToolPreHookPayload extends HookScope {
  step: number;
  callId: string;
  toolKey: string;
  specHash: string;
  input: unknown;
}

/** `tool.postExecute`: after a tool call finished, with the result the model sees. */
export interface ToolPostHookPayload extends ToolPreHookPayload {
  isError: boolean;
  content: string;
  durationMs: number;
}

/**
 * `usage.report`: the usage of one model call, delivered through a queue with retries. Handlers must
 * be idempotent by `eventId` (`<conversationId>/<seq>`).
 */
export interface UsageReportPayload {
  eventId: string;
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  conversationKind: "chat" | "eval";
  runId: string;
  provider: string;
  model: string;
  usage: ModelUsage;
  occurredAt: string;
}

/** Payload type of each mount point. */
export interface HookPayloads {
  "model.request": ModelRequestHookPayload;
  "model.response": ModelResponseHookPayload;
  "tool.preExecute": ToolPreHookPayload;
  "tool.postExecute": ToolPostHookPayload;
  "usage.report": UsageReportPayload;
}

/**
 * What a hook returns: nothing, or `{ deny: reason }`. A deny only takes effect for a `policy` hook
 * on a mount point in {@link POLICY_HOOKS}; it is ignored everywhere else. Hooks never rewrite the
 * request or the result.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: handlers that return nothing must type-check
export type HookVerdict = void | { deny: string };

/**
 * A hook handler. The payload is a deep-frozen copy (mutating it throws). `signal` aborts when the
 * hook runs past `hooks.timeoutMs` or the call it observes is aborted.
 */
export type HookHandler<K extends AvailableHook> = (
  payload: HookPayloads[K],
  signal: AbortSignal,
) => Promise<HookVerdict> | HookVerdict;

/**
 * `observe`: errors, timeouts and verdicts are ignored. `policy`: a deny, an error or a timeout blocks
 * the call (only on {@link POLICY_HOOKS}).
 */
export interface HookOptions {
  mode: "observe" | "policy";
}

/** Mount points where a `policy` hook may deny the call. */
export const POLICY_HOOKS: readonly AvailableHook[] = ["model.request", "tool.preExecute"];
