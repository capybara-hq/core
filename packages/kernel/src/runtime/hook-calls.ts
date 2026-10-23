import type {
  AvailableHook,
  ContentBlock,
  HookPayloads,
  HookScope,
  Logger,
  ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { EventPayload } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import type { HookOutcome, HookRegistry } from "../plugins/hooks.js";

/** What the runtime needs from the host's hook registry (absent in eval replays). */
export type HookRunner = Pick<HookRegistry, "run" | "has">;

/** Kind of the conversation a run belongs to; hooks fire only for `chat` (F10, P-18). */
export type ConversationKindForHooks = "chat" | "eval";

/** A denial as `run()` returns it. */
export type HookDenial = Extract<HookOutcome, { allowed: false }>;

/**
 * The scope for hook payloads, or null when hooks must not fire: no registry (eval replays omit it),
 * a conversation that is not `chat`, or missing identity fields.
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
  },
): HookScope | null {
  if (!hooks || s.conversationKind !== "chat") return null;
  if (s.accountId === undefined || s.agentId === undefined) return null;
  return {
    orgId: s.orgId,
    accountId: s.accountId,
    agentId: s.agentId,
    agentVersion: s.agentVersion,
    conversationId: s.conversationId,
    runId: s.runId,
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
  log: Logger,
): void {
  if (!hooks.has(mount)) return;
  hooks.run(mount, payload, signal).catch((err: unknown) => {
    // run() only rejects when the caller aborted: nothing to do
    if (!signal.aborted) log.warn("observe hooks failed to dispatch", { mount, err });
  });
}

/**
 * The `model.request` payload's request without attachment `ref` ids (M-3). The request sent to the
 * provider never carries refs (the kernel resolves them to bytes or text placeholders), so this
 * normally returns the request unchanged; it only guards against a ref slipping through.
 */
export function withoutMediaRefs(request: ModelRequest, log?: Pick<Logger, "warn">): ModelRequest {
  const hasRef = (b: ContentBlock) =>
    (b.type === "image" || b.type === "document") && b.source.kind === "ref";
  if (!request.messages.some((m) => typeof m.content !== "string" && m.content.some(hasRef))) {
    return request;
  }
  log?.warn("attachment refs reached a model.request hook payload; stripped them", {
    model: request.model,
  });
  return {
    ...request,
    messages: request.messages.map((m) =>
      typeof m.content === "string"
        ? m
        : {
            ...m,
            content: m.content.map(
              (b): ContentBlock => (hasRef(b) ? { type: "text", text: "[attachment omitted]" } : b),
            ),
          },
    ) as ModelRequest["messages"],
  };
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
  d: { db: KernelDb; eventLog: EventLog },
  at: DenialSite,
  mount: Extract<AvailableHook, "model.request" | "tool.preExecute">,
  denial: HookDenial,
  where: { step: number; attempt?: number; callId?: string },
): Promise<void> {
  if (await d.eventLog.findByIdem(at.conversationId, at.idemKey)) return;
  const event = hookDeniedEvent(at, mount, denial, where);
  const written = await d.db.transaction().execute(async (t) => {
    const out = await d.eventLog.append(at.conversationId, [event], t);
    await audit(t, hookDeniedAudit(at, event.payload, denial));
    return out;
  });
  if (written.length > 0) {
    await d.eventLog.notify(at.conversationId, Math.max(...written.map((e) => e.seq)));
  }
}
