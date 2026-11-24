import { describe, expect, it } from "vitest";
import { setupNeed } from "../../src/tools/connector-setup.js";
import type { ConnectorAuth } from "../../src/tools/credentials.js";

// The same case table as the web's `templateNeed` (apps/web/test/catalog-template-need.test.ts):
// the two must agree on which connectors need org input.
describe("setupNeed", () => {
  const cases: [string, Record<string, unknown>, "client" | "credential" | undefined][] = [
    ["no auth", { type: "none" }, undefined],
    ["oauth_client", { type: "oauth_client" }, "client"],
    ["oauth_code with a manual client", { type: "oauth_code", client: "manual" }, "client"],
    [
      "oauth_code with automatic registration",
      { type: "oauth_code", client: "dcr", discovery: "mcp" },
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
    it(name, () => expect(setupNeed(auth as ConnectorAuth)).toBe(want));
  }
});
