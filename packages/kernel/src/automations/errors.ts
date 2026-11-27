import { ApiError } from "../errors.js";

/** The task is missing, deleted, in another org or not the caller's to see (never 403). */
export const automationNotFound = () =>
  new ApiError("automation.not_found", "Automation not found");

/** An org admin acting on another person's task in a way only its creator may (spec §10). */
export const automationForbidden = () =>
  new ApiError(
    "automation.forbidden",
    "Only the task's creator can change its prompt, schedule, target or approved tools",
  );

export const automationDisabled = () =>
  new ApiError("automation.disabled", "Automations are turned off in this organization");

export const targetInvalid = (message: string) =>
  new ApiError("automation.target_invalid", message);

export const grantNotAllowed = (message: string) =>
  new ApiError("automation.grant_not_allowed", message);

/** The event source is not an enabled trigger source of the org (or the org switched it off). */
export const eventSourceUnavailable = (message: string) =>
  new ApiError("automation.event_source_unavailable", message);

/** An event type the source does not declare (or one that is directed). */
export const eventTypeUnknown = (message: string) =>
  new ApiError("automation.event_type_unknown", message);

/**
 * "Run now" or a trial run of an event automation: its runs are made from its events (collaboration
 * spec §4.1), so there is nothing to run outside them.
 */
export const runNowUnsupported = () =>
  new ApiError(
    "automation.run_now_unsupported",
    "An event automation runs only when its events arrive, so it cannot be run now or as a trial; make an event of its source happen to test it, or switch it to a schedule",
  );

/** A filter clause on a missing, unfilterable or mistyped fact. */
export const filterInvalid = (message: string) =>
  new ApiError("automation.filter_invalid", message);
