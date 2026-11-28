import { describe, expect, it } from "vitest";
import { isUiTemplate, listableResource } from "../../src/tools/connector-content.js";

describe("isUiTemplate", () => {
  it.each([
    [{ uri: "ui://x" }],
    [{ uri: "UI://x" }],
    [{ uri: "a://b", mimeType: "text/html; profile=mcp-app" }],
    [{ uri: "a://b", mimeType: "TEXT/HTML;PROFILE=MCP-APP" }],
  ])("is a UI template: %j", (r) => {
    expect(isUiTemplate(r)).toBe(true);
  });

  it.each([
    [{ uri: "a://b", mimeType: "text/html" }],
    [{ uri: "https://ui.example" }],
    [{ uri: "docs://handbook", mimeType: "text/markdown" }],
  ])("is not a UI template: %j", (r) => {
    expect(isUiTemplate(r)).toBe(false);
  });
});

describe("listableResource", () => {
  it("hides empty resources and UI templates", () => {
    expect(listableResource({ uri: "a://b", name: "b", size: 0 })).toBe(false);
    expect(listableResource({ uri: "ui://b", name: "b" })).toBe(false);
  });

  it("lists a resource of unknown or positive size", () => {
    expect(listableResource({ uri: "a://b", name: "b" })).toBe(true);
    expect(listableResource({ uri: "a://b", name: "b", size: 12 })).toBe(true);
  });
});
