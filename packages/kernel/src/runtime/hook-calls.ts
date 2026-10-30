import type {
  AvailableHook,
  ContentBlock,
  HookContentBlock,
  HookMediaPlaceholder,
  HookModelMessage,
  HookModelRequest,
  HookParentScope,
  HookPayloads,
  HookScope,
  Logger,
  ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { EventPayload } from "../conversations/events.js";
import type { HookOutcome, HookRegistry } from "../extensions/hooks.js";
import type { audit } from "../identity/audit.js";
import type { StepLog } from "./step-log.js";

/** What the runtime needs from the host's hook registry (absent in eval replays). */
export type HookRunner = Pick<HookRegistry, "run" | "has">;

/**
 * Kind of the conversation a run belongs to; hooks fire for `chat` and `subagent` (F10, P-18,
 * sub-agents spec §11), never for `eval`.
 */
export type ConversationKindForHooks = "chat" | "eval" | "subagent";

/** A denial as `run()` returns it. */
export type HookDenial = Extract<HookOutcome, { allowed: false }>;

/**
 * The scope for hook payloads, or null when hooks must not fire: no registry (eval replays omit it),
 * a conversation that is neither `chat` nor `subagent`, or missing identity fields. A sub-agent's
 * scope carries `parent` (where it was dispatched from).
 */
export function hookScope(
  hooks: HookRunner | undefined,
  s: {
    conversationKind?: ConversationKindForHooks;
    orgId: string;
    accountId?: string;
    agentId?: string;
    agentVersion: number;
    conversationId: string;
    runId: string;
    parent?: HookParentScope | undefined;
  },
): HookScope | null {
  if (!hooks || (s.conversationKind !== "chat" && s.conversationKind !== "subagent")) return null;
  if (s.accountId === undefined || s.agentId === undefined) return null;
  return {
    orgId: s.orgId,
    accountId: s.accountId,
    agentId: s.agentId,
    agentVersion: s.agentVersion,
    conversationId: s.conversationId,
    runId: s.runId,
    ...(s.parent !== undefined && {
      parent: {
        conversationId: s.parent.conversationId,
        runId: s.parent.runId,
        callId: s.parent.callId,
      },
    }),
  };
}

/**
 * Fires observe-only hooks (`model.response`, `tool.postExecute`) without waiting. `signal` must be
 * run-scoped (not a per-call controller aborted when the call ends), or the hooks would be cut off.
 */
export function fireObserve<K extends "model.response" | "tool.postExecute">(
  hooks: HookRunner,
  mount: K,
  payload: HookPayloads[K],
  signal: AbortSignal,
  log: Pick<Logger, "warn">,
): void {
  if (!hooks.has(mount)) return;
  hooks.run(mount, payload, signal).catch((err: unknown) => {
    // run() only rejects when the caller aborted: nothing to do
    if (!signal.aborted) log.warn("observe hooks failed to dispatch", { mount, err });
  });
}

/** Decoded size of standard padded base64, in bytes. */
const base64Bytes = (data: string): number => {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length / 4) * 3 - pad);
};

/**
 * The `model.request` payload's request (F10, I-3): the request sent to the provider with every image
 * and document block replaced by a {@link HookMediaPlaceholder} (`kind`, `mediaType`, decoded `size`),
 * so hook payloads carry neither media bytes nor attachment ids. Media never sits outside user
 * messages, but every message is projected anyway. Building the copy also keeps the per-call clone
 * and freeze of the payload small. A `ref` source should never reach here (the kernel resolves refs
 * before sending); it becomes a placeholder of size 0 and logs a warning.
 */
export function hookRequestOf(request: ModelRequest, log?: Pick<Logger, "warn">): HookModelRequest {
  let refs = 0;
  const project = (b: ContentBlock): HookContentBlock => {
    if (b.type !== "image" && b.type !== "document") return b;
    if (b.source.kind === "ref") refs++;
    return {
      type: "media_omitted",
      kind: b.type,
      mediaType: b.mediaType,
      size: b.source.kind === "base64" ? base64Bytes(b.source.data) : 0,
    } satisfies HookMediaPlaceholder;
  };
  const messages = request.messages.map(
    (m): HookModelMessage =>
      m.role === "system" ? m : { role: m.role, content: m.content.map(project) },
  );
  if (refs > 0) {
    log?.warn("attachment refs reached a model.request hook payload", {
      model: request.model,
      refs,
    });
  }
  return { ...request, messages };
}

/** Where a denial is recorded (conversation, run, actor and the idem key of its `hook_denied`). */
export interface DenialSite {
  orgId: string;
  conversationId: string;
  runId: string;
  accountId?: string;
  agentId?: string;
  idemKey: string;
}

/** The `hook_denied` event of a denial (not model-visible: request building skips it). */
export function hookDeniedEvent(
  at: DenialSite,
  mount: Extract<AvailableHook, "model.request" | "tool.preExecute">,
  denial: HookDenial,
  where: { step: number; attempt?: number; callId?: string },
): AppendEvent & { type: "hook_denied"; payload: EventPayload<"hook_denied"> } {
  return {
    type: "hook_denied",
    runId: at.runId,
    idemKey: at.idemKey,
    payload: {
      mount,
      plugin: denial.plugin,
      reason: denial.reason,
      cause: denial.cause,
      step: where.step,
      ...(where.attempt !== undefined && { attempt: where.attempt }),
      ...(where.callId !== undefined && { callId: where.callId }),
    },
  };
}

/**
 * The `hook.denied` audit entry of a denial. For an R10 denial (`preflight`) it says that no plugin ran
 * and that the named plugin is only the first policy plugin on the mount.
 */
export function hookDeniedAudit(
  at: DenialSite,
  payload: EventPayload<"hook_denied">,
  denial: HookDenial,
): AuditEntry {
  return {
    ...(at.accountId !== undefined && { actorAccountId: at.accountId }),
    orgId: at.orgId,
    action: "hook.denied",
    target: at.conversationId,
    detail: {
      ...payload,
      conversationId: at.conversationId,
      runId: at.runId,
      ...(at.agentId !== undefined && { agentId: at.agentId }),
      // the raw hook error: audit only, never in the conversation event (Ruling R12)
      ...(denial.detail !== undefined && { error: denial.detail }),
      ...(denial.preflight
        ? { preflight: true, firstPolicyPlugin: denial.plugin, causedByPlugin: false }
        : {}),
      // M-1: the named plugin is enabled but not loaded on the replica that handled the call
      ...(denial.notLoaded ? { notLoaded: true } : {}),
    },
  };
}

/** Audit entry shape (the argument of `audit()`). */
export type AuditEntry = Parameters<typeof audit>[1];

/**
 * Writes a model request's `hook_denied` event and its audit entry in one transaction (the tool path
 * writes them with the `tool_result` instead). Idempotent by idem key: a resumed run that finds the
 * denial rethrows it before running the hooks again, so no second audit entry is written.
 */
export async function recordHookDenial(
  d: { eventLog: EventLog; stepLog: Pick<StepLog, "appendAudited"> },
  at: DenialSite,
  mount: Extract<AvailableHook, "model.request" | "tool.preExecute">,
  denial: HookDenial,
  where: { step: number; attempt?: number; callId?: string },
): Promise<void> {
  if (await d.eventLog.findByIdem(at.conversationId, at.idemKey)) return;
  const event = hookDeniedEvent(at, mount, denial, where);
  const written = await d.stepLog.appendAudited(
    at.conversationId,
    [event],
    hookDeniedAudit(at, event.payload, denial),
  );
  if (written.length > 0) {
    await d.eventLog.notify(at.conversationId, Math.max(...written.map((e) => e.seq)));
  }
}
