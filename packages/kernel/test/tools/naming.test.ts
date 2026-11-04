import { connectorToolKey } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { deriveSlug, isValidSlug, toolKeyIssue } from "../../src/tools/naming.js";

describe("工具命名", () => {
  it("deriveSlug：转小写、折叠非字母数字、去掉开头数字、截到 24 位；推导不出返回 null", () => {
    expect(deriveSlug("Docs")).toBe("docs");
    expect(deriveSlug("My Docs!")).toBe("my_docs");
    expect(deriveSlug("  123 Jira -- Cloud ")).toBe("jira_cloud");
    expect(deriveSlug("a".repeat(30))).toBe("a".repeat(24));
    expect(deriveSlug(`${"a".repeat(23)} b`)).toBe("a".repeat(23));
    expect(deriveSlug("飞书文档")).toBeNull();
    expect(deriveSlug("123")).toBeNull();
  });

  it("isValidSlug：拒绝连续下划线、结尾下划线、大写与超长", () => {
    expect(isValidSlug("docs_v2")).toBe(true);
    expect(isValidSlug("a__b")).toBe(false);
    expect(isValidSlug("docs_")).toBe(false);
    expect(isValidSlug("Docs")).toBe(false);
    expect(isValidSlug("1docs")).toBe(false);
    expect(isValidSlug("a".repeat(25))).toBe(false);
  });

  it("toolKeyIssue：超过 64 字符或含非法字符给出原因，不截断", () => {
    expect(toolKeyIssue("mcp__docs__search")).toBeNull();
    expect(toolKeyIssue("a".repeat(64))).toBeNull();
    expect(toolKeyIssue("a".repeat(65))).toMatch(/65 characters; the limit is 64/);
    expect(toolKeyIssue("mcp__docs__has space")).toMatch(/outside \[a-zA-Z0-9_-\]/);
    expect(toolKeyIssue("mcp__docs__点")).toMatch(/outside/);
  });

  it("a connector key with the longest slug leaves 33 characters for the tool name", () => {
    const slug = "a".repeat(24);
    expect(toolKeyIssue(connectorToolKey(slug, "b".repeat(34)))).toMatch(
      /65 characters; the limit is 64/,
    );
    expect(toolKeyIssue(connectorToolKey(slug, "b".repeat(33)))).toBeNull();
  });
});
