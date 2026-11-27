import { ApiError } from "../errors.js";

/** The task is missing, deleted, in another org or not the caller's to see (never 403). */
export const scheduleNotFound = () =>
  new ApiError("schedule.not_found", "Scheduled task not found");

/** An org admin acting on another person's task in a way only its creator may (spec §10). */
export const scheduleForbidden = () =>
  new ApiError(
    "schedule.forbidden",
    "Only the task's creator can change its prompt, schedule, target or approved tools",
  );

export const scheduleDisabled = () =>
  new ApiError("schedule.disabled", "Scheduled tasks are turned off in this organization");

export const targetInvalid = (message: string) => new ApiError("schedule.target_invalid", message);

export const grantNotAllowed = (message: string) =>
  new ApiError("schedule.grant_not_allowed", message);
