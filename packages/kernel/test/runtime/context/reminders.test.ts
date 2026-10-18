import { describe, expect, it } from "vitest";
import { turnLimitReminder } from "../../../src/runtime/context/reminders.js";

describe("turnLimitReminder", () => {
  it("reminds from two steps before the limit", () => {
    expect(turnLimitReminder(7, 10)).toBeNull();
    expect(turnLimitReminder(8, 10)).toBe(
      "You are close to the step limit for this turn (step 8 of 10). Wrap up and give the user your best answer now.",
    );
    expect(turnLimitReminder(9, 10)).toContain("step 9 of 10");
  });
});
