import { describe, expect, it } from "vitest";
import {
  isModelError,
  isRetryableKind,
  MODEL_PROVIDER_CAPABILITY,
  ModelError,
  type ModelErrorKind,
} from "../src/index.js";

describe("isModelError / isRetryableKind", () => {
  it("duck-types a lookalike from another class", () => {
    class Other extends Error {
      kind = "aborted";
    }
    expect(isModelError(new Other("x"))).toBe(true);
    expect(isModelError(new ModelError("auth", "x"))).toBe(true);
  });
  it("rejects plain errors and non-errors", () => {
    expect(isModelError(new Error("x"))).toBe(false);
    expect(isModelError({ kind: "aborted" })).toBe(false);
    class Bad extends Error {
      kind = "nope";
    }
    expect(isModelError(new Bad("x"))).toBe(false);
  });
  it("isRetryableKind table", () => {
    for (const k of ["rate_limited", "overloaded", "server", "timeout", "network"] as const)
      expect(isRetryableKind(k)).toBe(true);
    for (const k of ["auth", "invalid_request", "context_overflow", "aborted"] as const)
      expect(isRetryableKind(k)).toBe(false);
  });
});

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
