import type {
  AvailableHook,
  ContentBlock,
  HookPayloads,
  HookScope,
  Logger,
  ModelRequest,
} from "@capybara-hq/plugin-sdk";
import type { EventLog } from "../conversations/event-log.js";
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
export function withoutMediaRefs(request: ModelRequest): ModelRequest {
  const hasRef = (b: ContentBlock) =>
    (b.type === "image" || b.type === "document") && b.source.kind === "ref";
  if (!request.messages.some((m) => typeof m.content !== "string" && m.content.some(hasRef))) {
    return request;
  }
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

/**
 * Writes a `hook_denied` event and a `hook.denied` audit entry in one transaction. The event is not
 * model-visible (request building skips it). For an R10 denial (`preflight`) the audit says that no
 * plugin ran and that the named plugin is only the first policy plugin on the mount.
 */
export async function recordHookDenial(
  d: { db: KernelDb; eventLog: EventLog },
  at: {
    orgId: string;
    conversationId: string;
    runId: string;
    accountId?: string;
    agentId?: string;
    idemKey: string;
  },
  mount: Extract<AvailableHook, "model.request" | "tool.preExecute">,
  denial: HookDenial,
  where: { step: number; attempt?: number; callId?: string },
): Promise<void> {
  // already recorded (a resumed run denied again): no second audit entry
  if (await d.eventLog.findByIdem(at.conversationId, at.idemKey)) return;
  const payload: EventPayload<"hook_denied"> = {
    mount,
    plugin: denial.plugin,
    reason: denial.reason,
    cause: denial.cause,
    step: where.step,
    ...(where.attempt !== undefined && { attempt: where.attempt }),
    ...(where.callId !== undefined && { callId: where.callId }),
    ...(denial.detail !== undefined && { detail: denial.detail }),
  };
  const written = await d.db.transaction().execute(async (t) => {
    const out = await d.eventLog.append(
      at.conversationId,
      [{ type: "hook_denied", runId: at.runId, idemKey: at.idemKey, payload }],
      t,
    );
    await audit(t, {
      ...(at.accountId !== undefined && { actorAccountId: at.accountId }),
      orgId: at.orgId,
      action: "hook.denied",
      target: at.conversationId,
      detail: {
        ...payload,
        conversationId: at.conversationId,
        runId: at.runId,
        ...(at.agentId !== undefined && { agentId: at.agentId }),
        ...(denial.preflight
          ? { preflight: true, firstPolicyPlugin: denial.plugin, causedByPlugin: false }
          : {}),
      },
    });
    return out;
  });
  if (written.length > 0) {
    await d.eventLog.notify(at.conversationId, Math.max(...written.map((e) => e.seq)));
  }
}
