import { describe, expect, it } from "vitest";
import { AgentDocs } from "../../src/platform/agent-docs.js";

describe("AgentDocs", () => {
  const docs = new AgentDocs();

  it("lists the fixed topics and one topic per extension point, with titles", () => {
    const topics = docs.topics();
    expect(topics.find((t) => t.id === "skills")?.title).toBe("Authoring: skills");
    expect(topics.some((t) => t.id.startsWith("extension-points/"))).toBe(true);
    expect(topics.find((t) => t.id === "extension-points/channel")?.title).toContain("channel");
  });

  it("reads a topic's Markdown, with its generated section", () => {
    expect(docs.read("plugin-format")).toContain("<!-- generated:plugin-manifest -->");
  });

  it("returns null for an unknown topic", () => {
    expect(docs.read("nope")).toBeNull();
    expect(docs.read("../package")).toBeNull();
  });
});
