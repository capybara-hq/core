import { DeviceOfflineError, DeviceRequestNotSentError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { attemptFailure, isUnreachable } from "../../src/background/stop.js";
import { DialInConnectionChangedError } from "../../src/dial-in/relay.js";
import { DeviceProgramRestartedError } from "../../src/sandbox/request-not-sent.js";

describe("why a stop attempt did not settle", () => {
  it("connectivity errors are unreachable, also as the cause of an unknown outcome", () => {
    const answerTimeout = Object.assign(new Error("no answer"), {
      name: "DialInAnswerTimeoutError",
      code: "device.answer_timeout",
    });
    for (const e of [
      new DeviceOfflineError("d1"),
      new DeviceRequestNotSentError("the connection changed before the request was sent"),
      new DeviceProgramRestartedError("backgroundStop"),
      new DialInConnectionChangedError(),
      answerTimeout,
      new Error("outcome unknown", { cause: new DeviceProgramRestartedError("backgroundStop") }),
      new Error("outcome unknown", { cause: new DeviceOfflineError("d1") }),
    ])
      expect(isUnreachable(e), e.message).toBe(true);
  });

  it("other errors are failures with their message; a caller abort is neither", () => {
    expect(isUnreachable(new Error("Managed background tasks are unavailable"))).toBe(false);
    expect(attemptFailure(new Error("boom"), false, false)).toEqual({
      kind: "failed",
      detail: "boom",
    });
    expect(attemptFailure(new DeviceOfflineError("d1"), false, false)?.kind).toBe("unreachable");
    expect(attemptFailure(new Error("x"), true, false)?.kind).toBe("unreachable");
    expect(attemptFailure(new Error("x"), false, true)).toBeUndefined();
  });
});
