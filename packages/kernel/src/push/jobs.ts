import type { PushMessage } from "@capybara-hq/plugin-sdk";

/**
 * The push queue's names, job ids and job data (mobile app spec §9.4). Ids are deterministic and
 * carry no `:` (kernel ids are UUIDs, seq is a number), so the outbox fast path and the relay
 * adding the same job twice, or an event owed again, is one job.
 */

/** Queue of push fanouts and deliveries (no `:` in the name). */
export const PUSH_QUEUE = "cap-push-deliver";

/** Resolves an event's recipients and owes one {@link PUSH_DELIVER_JOB} per registration. */
export const PUSH_FANOUT_JOB = "push-fanout";

/** Sends one message to one registration through the provider it names. */
export const PUSH_DELIVER_JOB = "push-deliver";

/** The event id of a conversation event (`conv-<conversationId>-<seq>`). */
export const conversationEventId = (conversationId: string, seq: number): string =>
  `conv-${conversationId}-${seq}`;

/** The event id of an automation run's settle (`automation-<taskRunId>`). */
export const automationRunEventId = (taskRunId: string): string => `automation-${taskRunId}`;

/** The event id of a personal inbox item's post (`inbox-<itemId>`). */
export const inboxItemEventId = (itemId: string): string => `inbox-${itemId}`;

/** One fanout per event: `push-fanout-<eventId>`. */
export const pushFanoutJobId = (eventId: string): string => `push-fanout-${eventId}`;

/** One delivery per event and registration: `push-<eventId>-<registrationId>`. */
export const pushDeliverJobId = (eventId: string, registrationId: string): string =>
  `push-${eventId}-${registrationId}`;

/** Data of a {@link PUSH_FANOUT_JOB}: the event, by id only (read when the job runs). */
export type PushFanoutData = {
  eventId: string;
  source:
    | { kind: "conversation"; conversationId: string; seq: number }
    | { kind: "automation"; taskRunId: string }
    | { kind: "inbox"; itemId: string };
};

/**
 * Data of a {@link PUSH_DELIVER_JOB}: the registration by id, the account it was rendered for and
 * the rendered message. Never the token: it is opened from the registration row when the job runs.
 * A registration whose token moved to another account since (review focus 3) is not sent to.
 */
export type PushDeliverData = {
  eventId: string;
  registrationId: string;
  accountId: string;
  message: PushMessage;
};
