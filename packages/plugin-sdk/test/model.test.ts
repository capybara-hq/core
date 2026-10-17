import { describe, expect, it } from "vitest";
import { MODEL_PROVIDER_CAPABILITY, ModelError, type ModelErrorKind } from "../src/index.js";

describe("ModelError", () => {
  it.each<[ModelErrorKind, boolean]>([
    ["rate_limited", true],
    ["overloaded", true],
    ["server", true],
    ["timeout", true],
    ["network", true],
    ["auth", false],
    ["invalid_request", false],
    ["context_overflow", false],
    ["aborted", false],
  ])("%s retryable=%s", (kind, retryable) => {
    expect(new ModelError(kind, "x").retryable).toBe(retryable);
  });
  it("keeps kind, retryAfterMs and cause", () => {
    const cause = new Error("c");
    const e = new ModelError("rate_limited", "slow", { retryAfterMs: 1500, cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(1500);
    expect(e.cause).toBe(cause);
  });
});

describe("model-provider capability", () => {
  it("constant", () => {
    expect(MODEL_PROVIDER_CAPABILITY).toBe("model-provider@1");
  });
});
