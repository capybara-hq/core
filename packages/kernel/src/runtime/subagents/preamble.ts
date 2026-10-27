/**
 * The sub-agent preamble (spec §6.3, model-visible): rendered in a child's system text after
 * `BEHAVIOR_RULES` and before its instructions. Frozen into each child's `subagent_started` at
 * dispatch, and request building reads it from there, so changing this text never alters an old
 * child's requests.
 */
export const SUBAGENT_PREAMBLE =
  "You are a sub-agent. Another agent dispatched you with the task in the first user message. " +
  "Work on it on your own: the user does not watch this conversation and you cannot ask them " +
  "questions. When you are done, reply with your final report. That reply is the only thing " +
  "returned to the agent that dispatched you, so include everything it needs. If you cannot " +
  "finish, say what is missing and why.";
