import { describe, expect, it } from "vitest";
import { appendAuthorizationParams } from "../../../src/tools/oauth/authorization-params.js";

const kernelUrl = () => {
  const u = new URL("https://as.example.com/authorize?tenant=acme");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", "s".repeat(43));
  return u;
};

describe("appendAuthorizationParams", () => {
  it("appends each entry after the kernel's own parameters", () => {
    const u = kernelUrl();
    const skipped = appendAuthorizationParams(u, { access_type: "offline", prompt: "consent" });
    expect(skipped).toEqual([]);
    expect([...u.searchParams.keys()]).toEqual([
      "tenant",
      "response_type",
      "state",
      "access_type",
      "prompt",
    ]);
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("is a no-op without parameters", () => {
    const u = kernelUrl();
    expect(appendAuthorizationParams(u, undefined)).toEqual([]);
    expect(u.toString()).toBe(kernelUrl().toString());
  });

  it("skips a reserved name (a row written by hand cannot override the kernel) and reports it", () => {
    const u = kernelUrl();
    const skipped = appendAuthorizationParams(u, {
      state: "attacker",
      Response_Mode: "form_post",
      prompt: "consent",
    });
    expect(skipped).toEqual(["state", "Response_Mode"]);
    expect(u.searchParams.get("state")).toBe("s".repeat(43));
    expect(u.searchParams.has("Response_Mode")).toBe(false);
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("skips entries whose value is not a string", () => {
    const u = kernelUrl();
    const skipped = appendAuthorizationParams(u, { prompt: 1 } as unknown as Record<
      string,
      string
    >);
    expect(skipped).toEqual(["prompt"]);
    expect(u.searchParams.has("prompt")).toBe(false);
  });
});
