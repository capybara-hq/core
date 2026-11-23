import { describe, expect, it } from "vitest";
import {
  assertDeviceOfRunAccount,
  DEVICE_OF_ANOTHER_ACCOUNT_TEXT,
} from "../../src/tools/builtins/sandbox/device-owner.js";

describe("the run-account guard of the device entries", () => {
  const foreign = { accountId: "member", ownerAccountId: "owner" };

  it("another account's run is refused with the actionable text", () => {
    expect(() => assertDeviceOfRunAccount(foreign)).toThrow(DEVICE_OF_ANOTHER_ACCOUNT_TEXT);
    expect(() =>
      assertDeviceOfRunAccount({ accountId: "owner", ownerAccountId: "owner" }),
    ).not.toThrow();
    // a context with no owner (a hand-built call) is not refused
    expect(() => assertDeviceOfRunAccount({ accountId: "member" })).not.toThrow();
  });
});
