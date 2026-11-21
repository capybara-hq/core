import { describe, expect, it } from "vitest";
import { IdentitySourceRefused, isIdentitySourceRefused } from "../src/index.js";

describe("IdentitySourceRefused", () => {
  it("is an Error named IdentitySourceRefused that keeps its message", () => {
    const err = new IdentitySourceRefused("hosted domain not allowed");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IdentitySourceRefused");
    expect(err.message).toBe("hosted domain not allowed");
  });

  it("isIdentitySourceRefused: true for the class and for any Error with the marker name", () => {
    expect(isIdentitySourceRefused(new IdentitySourceRefused("x"))).toBe(true);
    // another SDK copy in the plugin's dependency tree: a different class, the same name
    expect(
      isIdentitySourceRefused(Object.assign(new Error("x"), { name: "IdentitySourceRefused" })),
    ).toBe(true);
  });

  it("isIdentitySourceRefused: false for other errors and non-errors", () => {
    expect(isIdentitySourceRefused(new Error("x"))).toBe(false);
    expect(isIdentitySourceRefused(new TypeError("x"))).toBe(false);
    expect(isIdentitySourceRefused({ name: "IdentitySourceRefused", message: "x" })).toBe(false);
    expect(isIdentitySourceRefused("IdentitySourceRefused")).toBe(false);
    expect(isIdentitySourceRefused(undefined)).toBe(false);
    expect(isIdentitySourceRefused(null)).toBe(false);
  });
});
