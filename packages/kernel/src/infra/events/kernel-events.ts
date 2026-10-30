import { Global, Inject, Injectable, Module } from "@nestjs/common";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER } from "../tokens.js";

/**
 * The kernel's in-process domain events (nest kernel spec §3b): a domain announces what happened,
 * and another domain reacts without the first depending on it. Same-process only, so only for
 * notifications that may be lost and are re-derived elsewhere; anything that must reach every
 * replica goes over the kernel bus (`KERNEL_BUS`).
 */
export interface KernelEventMap {
  /**
   * An organization was soft-deleted (after the commit). Channel connections drop their long
   * connections (the connection reads also filter deleted orgs, so a lost event only delays it).
   */
  "org.deleted": { orgId: string };
  /**
   * An organization disabled an extension (after the commit). Its channel connections in the org
   * drop their long connections at once (the supervisor's periodic re-check is the fallback).
   */
  "extension.org-disabled": { orgId: string; plugin: string };
  /**
   * A person decided a tool call approval (after the commit, exactly once: only the decision that
   * changed it from pending). The run's waits resume it and its IM delivery is enqueued; a lost
   * event is re-derived by the wait sweep (runs waiting on a decided approval are resumed).
   */
  "approval.decided": {
    id: string;
    orgId: string;
    conversationId: string;
    runId: string;
    status: "approved" | "denied";
  };
  /**
   * A person answered a tool call's input request (after the commit, exactly once). Same
   * consumers and the same re-derivation as `approval.decided`.
   */
  "question.answered": { id: string; orgId: string; conversationId: string; runId: string };
  /**
   * EventAppended: a conversation's event log advanced to `toSeq` (after the commit, from
   * `EventLog.notify`, right after the bus publish). The channel outbound delivery enqueues a job
   * for a conversation with an IM target; a lost event is re-derived by the next append's (and the
   * finished delivery job re-checks the log for content it has not delivered).
   */
  "conversation.event-appended": { conversationId: string; toSeq: number };
  /**
   * A run started executing on this replica (its first start, a resume, or a takeover after a
   * stall), after it took the conversation lock and an org quota slot. The channel outbound
   * enqueues the conversation's IM delivery; a lost event is re-derived by the run's next append.
   */
  "run.started": { conversationId: string; runId: string };
  /**
   * A stop of a run waiting on a person was handled (`RunControl.abortWaiting`, whether or not it
   * still waited): its approval and question cards change, so the channel outbound enqueues the
   * conversation's IM delivery (re-derived by the next append when lost).
   */
  "run.wait-stopped": { conversationId: string; runId: string };
  /**
   * `ensureRun` marked an orphaned run failed (after the commit): the waits stop its active
   * sub-agents at once. A lost event is repaired by the wait sweep (children of finished runs).
   */
  "run.orphaned": { runId: string };
}

/** The payload's id for the failure log (`approvalId` / `questionId`, as the old hooks logged). */
function idFields<K extends keyof KernelEventMap>(
  event: K,
  payload: KernelEventMap[K],
): Record<string, string> {
  const id = (payload as { id?: unknown }).id;
  if (typeof id !== "string") return {};
  if (event === "approval.decided") return { approvalId: id };
  if (event === "question.answered") return { questionId: id };
  return { id };
}

type Handler<K extends keyof KernelEventMap> = (payload: KernelEventMap[K]) => Promise<void> | void;

/** Typed in-process event emitter; handlers run in order, a failing one is logged and skipped. */
@Injectable()
export class KernelEvents {
  private readonly handlers = new Map<keyof KernelEventMap, Handler<never>[]>();

  constructor(@Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">) {}

  /** Subscribes; returns the unsubscribe function. */
  on<K extends keyof KernelEventMap>(event: K, handler: Handler<K>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(event, list);
    return () => {
      const at = list.indexOf(handler as Handler<never>);
      if (at >= 0) list.splice(at, 1);
    };
  }

  /** Runs every handler of `event` and waits for them. */
  async emit<K extends keyof KernelEventMap>(event: K, payload: KernelEventMap[K]): Promise<void> {
    for (const h of [...(this.handlers.get(event) ?? [])]) {
      try {
        await (h as Handler<K>)(payload);
      } catch (err) {
        this.log.warn("kernel event handler failed", { event, ...idFields(event, payload), err });
      }
    }
  }
}

/** Global: the one {@link KernelEvents}. */
@Global()
@Module({ providers: [KernelEvents], exports: [KernelEvents] })
export class KernelEventsModule {}
