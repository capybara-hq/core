import type { ToolStepContext } from "../../src/tools/pipeline.js";

/**
 * The who-and-where fields every `ToolStepContext` carries (memory plugin spec §6.2), for tests
 * that build one by hand: a web conversation owned by `accountId`, run by that account as `role`.
 */
export const webCaller = (
  accountId: string,
  role: ToolStepContext["role"] = "owner",
): Pick<ToolStepContext, "source" | "ownerAccountId" | "role"> => ({
  source: "web",
  ownerAccountId: accountId,
  role,
});
