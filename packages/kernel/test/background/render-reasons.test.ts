import { describe, expect, it } from "vitest";
import { lostReasonText, taskReasonText } from "../../src/background/render.js";
import { REVOKED_LAUNCH_REASON } from "../../src/sandbox/operation-intents.js";

// TaskList, TaskOutput and the finished-task message show a lost task's reason as kernel text:
// the launch outcomes the kernel records are never shown as raw codes.
describe("lost reasons", () => {
  it("renders an unknown or revoked launch as kernel text", () => {
    for (const reason of ["launch_unknown", REVOKED_LAUNCH_REASON]) {
      const text = lostReasonText(reason);
      expect(text, reason).not.toBe(reason);
      expect(text).not.toMatch(/_/);
      expect(text).toMatch(/being stopped/);
      expect(taskReasonText({ lostReason: reason, launchState: "terminal" })).toBe(text);
    }
    expect(lostReasonText("launch_unknown")).toMatch(/could not be confirmed/);
    expect(lostReasonText(REVOKED_LAUNCH_REASON)).toMatch(/revoked/);
  });
});
