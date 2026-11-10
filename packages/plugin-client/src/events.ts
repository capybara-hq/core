import type { CapybaraEventType } from "./types.js";

/** Every client event name, for hosts and tests. */
export const CAPYBARA_EVENT_TYPES: readonly CapybaraEventType[] = [
  "run.started",
  "run.finished",
  "run.failed",
  "message.sent",
  "message.received",
  "tool.started",
  "tool.finished",
  "approval.requested",
];
