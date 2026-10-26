import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_LIMITS,
  AGENT_TEMPLATE_NAME_RE,
  type AgentTemplate,
  parseAgentTemplate,
} from "../src/index.js";

const md = (front: string, body = "You review code.\n") => `---\n${front}\n---\n${body}`;
const base = "name: code-reviewer\ndescription: Reviews a change against the plan.";

const errorsOf = (text: string): string[] => {
  const r = parseAgentTemplate(text);
  return "errors" in r ? r.errors : [];
};

describe("parseAgentTemplate", () => {
  it("parseAgentTemplate reads frontmatter and body", () => {
    const text = md(
      [
        "name: code-reviewer",
        "description: >",
        "  Reviews a change against the plan.",
        "tools: [sandbox_bash, sandbox_read, todo__write]",
        "disallowedTools: [sandbox_write]",
        "toolPolicies:",
        "  sandbox_bash: ask",
        "  todo__write: deny",
        "model: capable",
        "effort: high",
        "maxSteps: 40",
        "skills: [pdf-tools, writing-plans]",
        "color: blue",
      ].join("\n"),
      "# Reviewer\n\nCheck everything.\n",
    );
    const expected: AgentTemplate = {
      name: "code-reviewer",
      description: "Reviews a change against the plan.",
      instructions: "# Reviewer\n\nCheck everything.\n",
      tools: ["sandbox_bash", "sandbox_read", "todo__write"],
      disallowedTools: ["sandbox_write"],
      toolPolicies: { sandbox_bash: "ask", todo__write: "deny" },
      model: "capable",
      effort: "high",
      maxSteps: 40,
      skills: ["pdf-tools", "writing-plans"],
    };
    expect(parseAgentTemplate(text)).toEqual({ template: expected });
  });

  it("optional fields stay absent; BOM and CRLF are tolerated", () => {
    expect(parseAgentTemplate(`﻿${md(base, "Body\nline")}`.replace(/\n/g, "\r\n"))).toEqual({
      template: {
        name: "code-reviewer",
        description: "Reviews a change against the plan.",
        instructions: "Body\nline",
      },
    });
  });

  const rejects: [string, string, string][] = [
    ["a missing name", md("description: D"), "name is required"],
    ["a missing description", md("name: code-reviewer"), "description is required"],
    [
      "a bad name",
      md("name: Code_Reviewer\ndescription: D"),
      "name must match ^[a-z0-9][a-z0-9-]{0,63}$",
    ],
    [
      "unknown model tier",
      md(`${base}\nmodel: opus`),
      "model must be one of inherit, fast, standard, capable",
    ],
    ["maxSteps < 1", md(`${base}\nmaxSteps: 0`), "maxSteps must be an integer of at least 1"],
    [
      "more than 3 skills",
      md(`${base}\nskills: [a, b, c, d]`),
      "skills must list at most 3 skill names",
    ],
    [
      "a body over 100000 chars",
      md(base, "x".repeat(AGENT_TEMPLATE_LIMITS.bodyChars + 1)),
      "the body (instructions) must be at most 100000 characters",
    ],
    [
      "a description over 4096 chars",
      md(`name: a\ndescription: ${"d".repeat(4097)}`),
      "description must be at most 4096 characters",
    ],
    [
      "an unknown effort",
      md(`${base}\neffort: huge`),
      "effort must be one of low, medium, high, xhigh, max",
    ],
    [
      "a non-string tool",
      md(`${base}\ntools: [1]`),
      "tools must be a list of at most 200 distinct tool keys (letters, digits, _ and -, up to 64 characters)",
    ],
    [
      "a tool key with a dot",
      md(`${base}\ntools: [todo.write]`),
      "tools must be a list of at most 200 distinct tool keys (letters, digits, _ and -, up to 64 characters)",
    ],
    [
      "a repeated tool key",
      md(`${base}\ntools: [sandbox_bash, sandbox_bash]`),
      "tools must be a list of at most 200 distinct tool keys (letters, digits, _ and -, up to 64 characters)",
    ],
    [
      "a disallowed tool key with a space",
      md(`${base}\ndisallowedTools: [sandbox bash]`),
      "disallowedTools must be a list of at most 200 distinct tool keys (letters, digits, _ and -, up to 64 characters)",
    ],
    [
      "a tool policy for a dotted key",
      md(`${base}\ntoolPolicies:\n  todo.write: deny`),
      "toolPolicies must map tool keys to ask or deny",
    ],
    [
      "an allow tool policy",
      md(`${base}\ntoolPolicies:\n  sandbox_bash: allow`),
      "toolPolicies must map tool keys to ask or deny",
    ],
    ["a bad skill name", md(`${base}\nskills: [Bad]`), "skills must list at most 3 skill names"],
    [
      "no frontmatter",
      "just text",
      "an agent template must start with YAML frontmatter delimited by '---' lines",
    ],
  ];
  for (const [label, text, error] of rejects) {
    it(`rejects ${label}`, () => {
      expect(errorsOf(text)).toEqual([error]);
    });
  }

  it("the name rule", () => {
    expect(AGENT_TEMPLATE_NAME_RE.test("a")).toBe(true);
    expect(AGENT_TEMPLATE_NAME_RE.test("9-lives")).toBe(true);
    expect(AGENT_TEMPLATE_NAME_RE.test("-a")).toBe(false);
    expect(AGENT_TEMPLATE_NAME_RE.test("a".repeat(65))).toBe(false);
  });
});
