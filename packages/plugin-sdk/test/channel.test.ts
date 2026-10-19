import { describe, expect, it } from "vitest";
import { ChannelSendError, isChannelSendError } from "../src/index.js";

describe("ChannelSendError", () => {
  it("带可重试标记与建议等待时长；鸭子类型识别", () => {
    const e = new ChannelSendError("rate limited", { retryable: true, retryAfterMs: 1200 });
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(1200);
    expect(isChannelSendError(e)).toBe(true);
    const fatal = new ChannelSendError("bot removed", { retryable: false });
    expect(fatal.retryable).toBe(false);
    expect(fatal.retryAfterMs).toBeUndefined();
    // 另一份 SDK 副本抛出的同名错误同样识别
    const foreign = Object.assign(new Error("x"), { name: "ChannelSendError", retryable: false });
    expect(isChannelSendError(foreign)).toBe(true);
    expect(isChannelSendError(new Error("plain"))).toBe(false);
    expect(isChannelSendError({ name: "ChannelSendError", retryable: true })).toBe(false);
  });
});
