import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";

describe("CLAUDE_CODE_TOOL_MAP", () => {
  it("names the shared Claude Code tools as unchanged and maps only the others", () => {
    const lines = CLAUDE_CODE_TOOL_MAP.split("\n");
    expect(lines.slice(0, 3).join(" ")).toBe(
      "Some skills in this conversation were written for Claude Code. Its tools Bash, Read, Write, Edit, Glob, Grep, Skill, AskUserQuestion, ToolSearch and Agent have the same names here, when they are in your tools. For the others:",
    );
    expect(lines).toContain("- MultiEdit -> several Edit calls");
    expect(lines).toContain(
      "- Task -> Agent; SendMessage to a sub-agent -> Agent with resume; model names haiku / sonnet / opus -> fast / standard / capable",
    );
    expect(CLAUDE_CODE_TOOL_MAP).not.toMatch(/sandbox_|skill_load|ask_user|tool_search/);
    expect(CLAUDE_CODE_TOOL_MAP).toContain("after Skill has copied that skill");
  });
});
