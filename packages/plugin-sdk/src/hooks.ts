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

/** Where a sub-agent was dispatched from: the parent conversation, its run and the `agent` call. */
export interface HookParentScope {
  conversationId: string;
  runId: string;
  /**
   * The `agent` call's id; `skill-<seq>` for a person's forked skill invocation, which has no
   * tool call in the parent's log.
   */
  callId: string;
}

/**
 * Who and where a model or tool hook fires for. Hooks fire in chat conversations and in
 * sub-agents' conversations (never in eval replays).
 */
export interface HookScope {
  orgId: string;
  accountId: string;
  agentId: string;
  agentVersion: number;
  conversationId: string;
  runId: string;
  /** Set when the call belongs to a sub-agent: where it was dispatched from. */
  parent?: HookParentScope;
}

/**
 * What a model call is for: `step` is a run step's call (the agent's turn), `compaction` is the call
 * that summarizes earlier history before a step when the context grows too large, `title` is the call
 * that writes a conversation's title after its first completed run (no run: `runId` is "", `step` 0,
 * `attempt` 1).
 */
export type ModelCallPurpose = "step" | "compaction" | "title";

/** What a reported model call was for (the same values as {@link ModelCallPurpose}). */
export type UsagePurpose = ModelCallPurpose;

/**
 * An image or document of a `model.request` payload. Hook payloads never carry media bytes or
 * attachment ids: each image or document block is replaced by this placeholder.
 * `size` is the size of the bytes sent to the provider, in bytes (0 when unknown).
 */
export interface HookMediaPlaceholder {
  type: "media_omitted";
  kind: "image" | "document";
  mediaType: string;
  size: number;
}

/** A content block of a `model.request` payload: image and document blocks become placeholders. */
export type HookContentBlock =
  | Exclude<ContentBlock, { type: "image" } | { type: "document" }>
  | HookMediaPlaceholder;

/** A message of a `model.request` payload (see {@link HookContentBlock}). */
export type HookModelMessage =
  | { role: "user"; content: HookContentBlock[] }
  | { role: "assistant"; content: HookContentBlock[] }
  | { role: "system"; content: string };

/** The request of a `model.request` payload: the request sent to the provider, without media bytes. */
export type HookModelRequest = Omit<ModelRequest, "messages"> & { messages: HookModelMessage[] };

/**
 * `model.request`: before a model call is sent. A policy hook may deny it. Fires once per attempt of a
 * step (`purpose: "step"`), once for each compaction call (`purpose: "compaction"`, `attempt` 1) and
 * once for each conversation title call (`purpose: "title"`, `runId` "", `step` 0, `attempt` 1; a
 * denial skips the title and is recorded only in the audit log).
 * `request` is the request as sent, except that images and documents are placeholders
 * ({@link HookMediaPlaceholder}): no media bytes, no attachment ids.
 */
export interface ModelRequestHookPayload extends HookScope {
  purpose: ModelCallPurpose;
  step: number;
  attempt: number;
  provider: string;
  model: string;
  request: Readonly<HookModelRequest>;
}

/**
 * `model.response`: after a sent model call finished or failed, with its usage when known (step
 * attempts, compaction and title calls, see `purpose`). Not fired for a call the user aborted (the run was
 * stopped while the call was in flight), nor for a call that was never sent (denied, or failed
 * before sending), so a `model.request` can have no matching `model.response`.
 */
export interface ModelResponseHookPayload extends HookScope {
  purpose: ModelCallPurpose;
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
 * `usage.report`: the usage of one model call that the event log recorded (chat runs and full-run eval
 * replays, see `conversationKind`), delivered through a queue **at least once**: a failed or
 * interrupted delivery is retried (up to 5 times, 2 s doubling), possibly on another replica, so
 * handlers must be idempotent by `eventId` (`<conversationId>/<seq>`). Delivered only while the
 * organization has the plugin enabled; the verdict is ignored.
 */
export interface UsageReportPayload {
  eventId: string;
  /**
   * A run step's call, a compaction call, or a conversation title call (`title`: no run, so
   * `runId` is ""). All are billed.
   */
  purpose: UsagePurpose;
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  /** A sub-agent's calls report `chat`; `parent` tells them apart. */
  conversationKind: "chat" | "eval";
  runId: string;
  /** Set when the call belongs to a sub-agent: where it was dispatched from. */
  parent?: HookParentScope;
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
 * - `policy` (only on {@link POLICY_HOOKS}): policy hooks run serially by plugin name (registration
 *   order within a plugin) before the call; the first `{ deny }`, error or timeout blocks the call and
 *   the rest are skipped. The model sees your deny reason (sanitized, at most 500 characters), but
 *   only a generic sentence for an error or a timeout.
 * - `observe`: dispatched after the policy hooks, concurrently and fire-and-forget, whether or not
 *   the call was denied; the call never waits for them. Verdicts, errors and timeouts are ignored
 *   (logged as throttled warnings). Each call keeps the `hooks.timeoutMs` limit and its abort signal;
 *   when too many observe calls of one plugin are in flight on a replica, new ones are dropped.
 *
 * A `policy` hook must also be declared in `permissions.policyHooks`. Policy hooks fail closed: when
 * a plugin that declares a policy hook on a mount point is enabled and approved but not loaded on the
 * replica that handles a call (setup failed, pending configuration, import failed), the call is
 * denied with a generic reason. Observe hooks of a plugin that is not loaded are simply skipped.
 */
export interface HookOptions {
  mode: "observe" | "policy";
}

/** Mount points where a `policy` hook may deny the call. */
export const POLICY_HOOKS = ["model.request", "tool.preExecute"] as const;

/** A mount point that accepts `policy` hooks (`permissions.policyHooks`). */
export type PolicyHook = (typeof POLICY_HOOKS)[number];
