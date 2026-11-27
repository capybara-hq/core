import type { ConversationEvent } from "../conversations/events.js";
import type { PushCategory } from "./push.schemas.js";

export type { PushCategory } from "./push.schemas.js";

/** The fixed sentences of a push body (`texts.ts` holds the copy). */
export type PushTextKey =
  | "approval"
  | "question"
  | "connect"
  | "runFinished"
  | "runFailed"
  | "backgroundFinished"
  | "subagentFinished"
  | "automationRan"
  | "automationFailed";

/** What one event pushes: its category (the person's switch) and its sentence. */
export interface PushTrigger {
  category: PushCategory;
  text: PushTextKey;
}

/**
 * The push an event of a conversation log triggers (mobile app spec §9.4, the plan's Triggers
 * table), or null. Pure: who receives it and whether it still applies (an approval still pending,
 * a chat conversation, a person's run) is decided when the fanout runs. A background task that a
 * person, a deletion or its sub-agent's end stopped pushes nothing; `run_aborted` (someone stopped
 * the run), `approval_decided` and `subagent_waiting` (the child's own `approval_requested` pushes)
 * push nothing.
 */
export function pushTriggerOf(e: Pick<ConversationEvent, "type" | "payload">): PushTrigger | null {
  switch (e.type) {
    case "approval_requested":
      return { category: "waiting", text: "approval" };
    case "question_asked":
      return { category: "waiting", text: "question" };
    case "connection_required":
      return { category: "waiting", text: "connect" };
    case "run_finished":
      return { category: "replies", text: "runFinished" };
    case "run_failed":
      return { category: "replies", text: "runFailed" };
    case "background_task_finished":
      return (e.payload as { stoppedBy?: unknown }).stoppedBy === undefined
        ? { category: "tasks", text: "backgroundFinished" }
        : null;
    case "subagent_finished":
      return { category: "tasks", text: "subagentFinished" };
    default:
      return null;
  }
}
