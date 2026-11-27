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
