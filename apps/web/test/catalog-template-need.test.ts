import { describe, expect, it } from "vitest";
import { templateNeed } from "../src/lib/catalog";

describe("templateNeed", () => {
  const cases: [string, Record<string, unknown>, "client" | "credential" | undefined][] = [
    ["no auth", { type: "none" }, undefined],
    ["oauth_client", { type: "oauth_client" }, "client"],
    ["oauth_code with a manual client", { type: "oauth_code", client: "manual" }, "client"],
    [
      "oauth_code with automatic registration",
      { type: "oauth_code", client: "dynamic" },
      undefined,
    ],
    ["oauth_code without a client field", { type: "oauth_code" }, undefined],
    ["bearer owned by the org", { type: "bearer", ownership: "org" }, "credential"],
    ["basic owned by the org", { type: "basic", ownership: "org" }, "credential"],
    ["api_key owned by the org", { type: "api_key", ownership: "org" }, "credential"],
    ["headers owned by the org", { type: "headers", ownership: "org" }, "credential"],
    ["bearer owned by each person", { type: "bearer", ownership: "personal" }, undefined],
  ];
  for (const [name, auth, want] of cases) {
    it(name, () => expect(templateNeed({ auth })).toBe(want));
  }
});
