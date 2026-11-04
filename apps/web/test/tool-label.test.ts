import { describe, expect, it } from "vitest";
import type { Approval } from "../src/lib/approvals";
import type { ToolInfo } from "../src/lib/conversations";
import { approvalToolLabel, toolLabel, toolLabelOfKey, toolLabelText } from "../src/lib/tool-label";

// One label for every surface that names a tool (tool naming spec §7): builtins by their name,
// connector and extension tools as "<display name> [<local tool>]", the declared title a tooltip.

const info = (over: Partial<ToolInfo>): ToolInfo => ({
  key: "Bash",
  title: null,
  kind: "command",
  sandbox: true,
  keyArgs: [],
  tool: null,
  source: { kind: "builtin" },
  ...over,
});

describe("toolLabel", () => {
  it("a builtin is its name, untranslated", () => {
    expect(toolLabel(info({}), "zh")).toEqual({ name: "Bash" });
    expect(toolLabel(info({}), "en")).toEqual({ name: "Bash" });
  });

  it("a connector tool is the connector's name and the local tool; the title is the tooltip", () => {
    const i = info({
      key: "mcp__crm__search_accounts",
      title: "Search accounts",
      kind: "connector",
      sandbox: false,
      tool: "search_accounts",
      source: { kind: "connector", id: "c1", name: "CRM" },
    });
    expect(toolLabel(i, "en")).toEqual({
      name: "CRM",
      tool: "search_accounts",
      tooltip: "Search accounts",
    });
    expect(toolLabelText(toolLabel(i, "en"))).toBe("CRM [search_accounts]");
  });

  it("an extension tool is the plugin's display name in the viewer's language", () => {
    const i = info({
      key: "plugin__todo__write",
      kind: "tool",
      sandbox: false,
      tool: "write",
      source: { kind: "extension", name: "todo", displayName: { zh: "待办", en: "Todo" } },
    });
    expect(toolLabel(i, "zh")).toEqual({ name: "待办", tool: "write" });
    expect(toolLabel(i, "en")).toEqual({ name: "Todo", tool: "write" });
  });

  it("an unknown source is the key", () => {
    const i = info({ key: "mcp__gone__x", kind: "tool", sandbox: false, tool: "x" });
    expect(toolLabel({ ...i, source: { kind: "unknown" } }, "en")).toEqual({
      name: "mcp__gone__x",
    });
  });
});

describe("toolLabelOfKey (no display metadata)", () => {
  it("parses the key: builtin, connector slug, extension name, else the key", () => {
    expect(toolLabelOfKey("Read")).toEqual({ name: "Read" });
    expect(toolLabelOfKey("mcp__crm__delete")).toEqual({ name: "crm", tool: "delete" });
    expect(toolLabelOfKey("plugin__todo__write")).toEqual({ name: "todo", tool: "write" });
    expect(toolLabelOfKey("weird key")).toEqual({ name: "weird key" });
  });
});

describe("approvalToolLabel", () => {
  const base = { toolKey: "mcp__crm__delete", toolName: "delete" };
  it("a connector tool reads the approval's connector name", () => {
    const a = { ...base, connector: { id: "c", name: "CRM", slug: "crm" }, extension: null };
    expect(approvalToolLabel(a as Pick<Approval, keyof typeof a>, "en")).toEqual({
      name: "CRM",
      tool: "delete",
    });
  });
  it("an extension tool reads the plugin display name", () => {
    const a = {
      toolKey: "plugin__todo__write",
      toolName: "plugin__todo__write",
      connector: null,
      extension: { name: "todo", displayName: { zh: "待办", en: "Todo" } },
    };
    expect(approvalToolLabel(a, "zh")).toEqual({ name: "待办", tool: "write" });
  });
  it("a builtin is its key", () => {
    expect(
      approvalToolLabel(
        { toolKey: "Bash", toolName: "Bash", connector: null, extension: null },
        "en",
      ),
    ).toEqual({ name: "Bash" });
  });
});
