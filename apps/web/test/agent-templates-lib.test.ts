import { describe, expect, it } from "vitest";
import {
  endpointIndexOf,
  endpointProblem,
  nameTakenOf,
  TEMPLATE_NAME_RE,
  templateNameFrom,
} from "../src/lib/agent-templates";

describe("templateNameFrom", () => {
  it("adjusts an agent name to the bare-name rule", () => {
    expect(templateNameFrom("Research Assistant")).toBe("research-assistant");
    expect(templateNameFrom("  --Weekly  Report v2!! ")).toBe("weekly-report-v2");
    expect(templateNameFrom("Café Bot")).toBe("cafe-bot");
    expect(TEMPLATE_NAME_RE.test(templateNameFrom("Research Assistant"))).toBe(true);
  });

  it("gives an empty name when nothing is usable, and at most 64 characters", () => {
    expect(templateNameFrom("研究助手")).toBe("");
    const long = templateNameFrom(`${"a".repeat(63)} b c`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("endpointProblem", () => {
  it("accepts a plain http(s) URL, also one the kernel only normalizes", () => {
    expect(endpointProblem("https://wiki.example.com/mcp")).toBeNull();
    expect(endpointProblem("https://Wiki.Example.com")).toBeNull();
  });

  it("names userinfo, a query and a fragment, with the clean form", () => {
    expect(endpointProblem("https://u:p@wiki.example.com/mcp?token=1#x")).toEqual({
      kind: "carries",
      parts: ["userinfo", "query", "fragment"],
      clean: "https://wiki.example.com/mcp",
    });
    expect(endpointProblem("https://wiki.example.com/mcp?k=v")).toEqual({
      kind: "carries",
      parts: ["query"],
      clean: "https://wiki.example.com/mcp",
    });
  });

  it("refuses what is no http(s) URL", () => {
    expect(endpointProblem("wiki.example.com")).toEqual({ kind: "invalid" });
    expect(endpointProblem("ftp://wiki.example.com")).toEqual({ kind: "invalid" });
  });
});

describe("nameTakenOf / endpointIndexOf", () => {
  it("reads the 409's first detail", () => {
    expect(nameTakenOf([{ reserved: true }])).toEqual({ reserved: true });
    expect(nameTakenOf([{ owner: { kind: "platform" }, templateId: "t" }])).toEqual({
      owner: { kind: "platform" },
    });
    expect(nameTakenOf([{ owner: { kind: "org", orgId: "o2", name: "Beta" } }])).toEqual({
      owner: { kind: "org", orgId: "o2", name: "Beta" },
    });
    expect(nameTakenOf([])).toBeNull();
  });

  it("finds the connector of an endpoint problem path", () => {
    expect(endpointIndexOf("definition.connectors.2.needs.endpoint")).toBe(2);
    expect(endpointIndexOf("definition")).toBeNull();
  });
});
