import { ToolError } from "@capybara-hq/plugin-sdk";

/** What a run another account triggered gets from every device entry. */
export const DEVICE_OF_ANOTHER_ACCOUNT_TEXT =
  "This conversation's device belongs to its owner, and this run was started by another member, so nothing ran on the device. Continue without the device, or ask the conversation's owner to run this.";

/**
 * The one run-account guard of every device entry (the sandbox tools' `inSandboxWith`, the task
 * tools, a background launch before its reservation is written): once the paired activation is
 * on, a run whose account is not the conversation's owner (a wake attributed to another member)
 * never uses the owner's device, refused before any device or database effect. Dormant, nothing
 * changes (the earlier behaviour).
 */
export function assertDeviceOfRunAccount(
  active: boolean | undefined,
  ctx: { accountId: string; ownerAccountId?: string | undefined },
): void {
  if (active && ctx.ownerAccountId !== undefined && ctx.ownerAccountId !== ctx.accountId)
    throw new ToolError(DEVICE_OF_ANOTHER_ACCOUNT_TEXT);
}
