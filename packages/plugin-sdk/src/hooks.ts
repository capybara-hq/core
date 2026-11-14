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
  "org.member_removed",
  "agent.deleted",
  "org.deleted",
] as const;

/** Lifecycle mount points: observe-only notices that something was removed. */
export const LIFECYCLE_HOOKS = ["org.member_removed", "agent.deleted", "org.deleted"] as const;

/** A mount point that `ctx.hooks.on` accepts. */
export type AvailableHook = (typeof HOOKS_AVAILABLE)[number];

/** Where a sub-agent was dispatched from: the parent conversation, its run and the `Agent` call. */
export interface HookParentScope {
  conversationId: string;
  runId: string;
  /**
   * The `Agent` call's id; `skill-<seq>` for a person's forked skill invocation, which has no
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
 * `attempt` 1), `web_fetch` is the call that extracts an answer from a fetched web page for the
 * `WebFetch` tool, `review` is the command-review classifier's call (`review` purpose, no run
 * step; absent = no classifier).
 */
export type ModelCallPurpose = "step" | "compaction" | "title" | "web_fetch" | "review";

/**
 * What a reported or requested model call was for: the {@link ModelCallPurpose} values, or
 * `embedding` for an embedding call an extension made through `ctx.models` (`usage.report`, and
 * `model.request` with {@link EmbeddingRequestHookPayload}; never `model.response`).
 */
export type UsagePurpose = ModelCallPurpose | "embedding";

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
 * `model.request` of a chat model call (see {@link ModelRequestHookPayload}): once per attempt of a
 * step (`purpose: "step"`), once for each compaction call (`purpose: "compaction"`, `attempt` 1),
 * once for each conversation title call (`purpose: "title"`, `runId` "", `step` 0, `attempt` 1; a
 * denial skips the title and is recorded only in the audit log) and once for each `WebFetch`
 * extraction call (`purpose: "web_fetch"`).
 * `request` is the request as sent, except that images and documents are placeholders
 * ({@link HookMediaPlaceholder}): no media bytes, no attachment ids.
 */
export interface ModelCallRequestHookPayload extends HookScope {
  purpose: ModelCallPurpose;
  step: number;
  attempt: number;
  provider: string;
  model: string;
  request: Readonly<HookModelRequest>;
}

/**
 * `model.request` of an embedding call an extension made through `ctx.models.embed`
 * (`purpose: "embedding"`): fired once per `embed` call, before the first batch is sent, with every
 * text of the call (the kernel splits them into batches afterwards). A call with no input sends
 * nothing and fires nothing. There is no conversation: the conversation fields of a chat model call
 * (`accountId`, `agentId`, `agentVersion`, `conversationId`, `runId`, `parent`, `step`, `attempt`,
 * `request`) are absent. A policy denial makes `embed` reject (`model.hook_denied`); nothing is sent
 * to the provider and no usage is recorded.
 */
export interface EmbeddingRequestHookPayload {
  purpose: "embedding";
  orgId: string;
  /** The extension that called `ctx.models.embed`. */
  extension: string;
  /** The embedding purpose the extension called with (one it declared in `permissions.models`). */
  embeddingPurpose: string;
  provider: string;
  model: string;
  /** The texts of the call, in order (text only). */
  input: readonly string[];
  /** The dimensions the extension asked for, when it asked. */
  dimensions?: number;
  /** The input type the extension gave, when it gave one. */
  inputType?: "query" | "document";
  accountId?: undefined;
  agentId?: undefined;
  agentVersion?: undefined;
  conversationId?: undefined;
  runId?: undefined;
  parent?: undefined;
}

/**
 * `model.request`: before a model call is sent. A policy hook may deny it. Either a chat model call
 * ({@link ModelCallRequestHookPayload}: steps, compaction, titles, `WebFetch`) or an extension's
 * embedding call ({@link EmbeddingRequestHookPayload}, `purpose: "embedding"`); tell them apart by
 * `purpose`. Handlers must accept the absent conversation fields of an embedding call (a policy
 * hook that throws on one denies the call). Payloads carry no media bytes.
 */
export type ModelRequestHookPayload = ModelCallRequestHookPayload | EmbeddingRequestHookPayload;

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
  /** The model-visible key: a builtin name, `mcp__<slug>__<tool>` or `plugin__<plugin>__<tool>`; split it with `parseToolKey`. */
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
  /** Absent for `embedding`. */
  accountId?: string;
  /** Absent for `embedding`. */
  agentId?: string;
  /** Absent for `embedding`. */
  conversationId?: string;
  /** A sub-agent's calls report `chat`; `parent` tells them apart. Absent for `embedding`. */
  conversationKind?: "chat" | "eval";
  /** Absent for `embedding`. */
  runId?: string;
  /** The calling extension; set for `embedding`. */
  extension?: string;
  /** Set when the call belongs to a sub-agent: where it was dispatched from. */
  parent?: HookParentScope;
  provider: string;
  model: string;
  usage: ModelUsage;
  occurredAt: string;
}

/**
 * `org.member_removed`: an account left the org (offboarding: removed by an admin, left on its own,
 * or offboarded by a directory sync). Lifecycle hooks are delivered durably, after the removal
 * committed, through a queue, at least once per plugin that declares the mount in
 * `permissions.hooks`, whether or not the org has the plugin enabled and whether or not the org's
 * effective config of the plugin is valid (`call.config` is the platform deployment config): they
 * exist so a plugin can delete the data it holds. Handlers must be idempotent. The payload carries
 * ids only.
 */
export interface OrgMemberRemovedPayload {
  orgId: string;
  accountId: string;
}

/**
 * `agent.deleted`: an agent was deleted. Delivered like {@link OrgMemberRemovedPayload} (durably, at
 * least once, regardless of org enablement or config validity; ids only).
 */
export interface AgentDeletedPayload {
  orgId: string;
  agentId: string;
}

/**
 * `org.deleted`: an org was deleted. Delivered like {@link OrgMemberRemovedPayload} (durably, at
 * least once, regardless of org enablement or config validity; ids only).
 */
export interface OrgDeletedPayload {
  orgId: string;
}

/** Payload type of each mount point. */
export interface HookPayloads {
  "model.request": ModelRequestHookPayload;
  "model.response": ModelResponseHookPayload;
  "tool.preExecute": ToolPreHookPayload;
  "tool.postExecute": ToolPostHookPayload;
  "usage.report": UsageReportPayload;
  "org.member_removed": OrgMemberRemovedPayload;
  "agent.deleted": AgentDeletedPayload;
  "org.deleted": OrgDeletedPayload;
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
 * hook runs past `hooks.timeoutMs` or the call it observes is aborted. `call.config` is the
 * extension's effective deployment config for the payload's org (the platform's config with the
 * org's copy applied to the overridable fields, or `ctx.config` while the org follows it); the
 * kernel always passes it, and never calls a hook for an org where that config is not valid
 * (observe hooks are skipped, policy hooks deny). Lifecycle hooks ({@link LIFECYCLE_HOOKS}) are the
 * exception: they get the platform deployment config and are always called.
 */
export type HookHandler<K extends AvailableHook> = (
  payload: HookPayloads[K],
  signal: AbortSignal,
  call?: HookCall,
) => Promise<HookVerdict> | HookVerdict;

/** The per-call context of a hook handler (see {@link HookHandler}). */
export interface HookCall {
  /**
   * The extension's effective deployment config for the payload's org (lifecycle hooks: the
   * platform deployment config).
   */
  config: unknown;
}

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
