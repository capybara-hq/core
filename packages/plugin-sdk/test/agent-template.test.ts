import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_FIELDS,
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
        "tools: [Bash, Read, plugin__todo__write]",
        "disallowedTools: [Write]",
        "toolPolicies:",
        "  Bash: ask",
        "  plugin__todo__write: deny",
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
      tools: ["Bash", "Read", "plugin__todo__write"],
      disallowedTools: ["Write"],
      toolPolicies: { Bash: "ask", plugin__todo__write: "deny" },
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
      md(`${base}\ntools: [Bash, Bash]`),
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
      md(`${base}\ntoolPolicies:\n  Bash: allow`),
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

describe("parseAgentTemplate: phase 4 fields (P4-1)", () => {
  const parse = (front: string) => {
    const r = parseAgentTemplate(md(`${base}\n${front}`));
    if (!("template" in r)) throw new Error(r.errors.join("; "));
    return r.template;
  };

  it("reads selectedSkills, connectors, subagents, modelRef, quickActions and instructionFiles", () => {
    const t = parse(
      [
        "selectedSkills: [pdf-tools, writing-plans]",
        "connectors:",
        "  - template: github",
        "    tools: [list_issues]",
        "  - template: other:jira",
        "  - needs:",
        "      protocol: mcp",
        "      endpoint: https://mcp.example.com/sse",
        "      tools: [search]",
        "      label: Wiki",
        "subagents:",
        "  general: true",
        "  types: [reviewer, superpowers:implementer]",
        "  inline:",
        "    - name: scout",
        "      description: Finds files.",
        "      instructions: Look around.",
        "      tools: [Read, Grep]",
        "      skills: [pdf-tools]",
        "      model: fast",
        "modelRef: anthropic/claude-x",
        "quickActions:",
        "  - title: Summarize",
        "    body: Summarize the thread.",
        "instructionFiles:",
        "  - name: style.md",
        "    content: Be brief.",
      ].join("\n"),
    );
    expect(t.selectedSkills).toEqual(["pdf-tools", "writing-plans"]);
    expect(t.connectors).toEqual([
      { template: "github", tools: ["list_issues"] },
      { template: "other:jira" },
      {
        needs: {
          protocol: "mcp",
          endpoint: "https://mcp.example.com/sse",
          tools: ["search"],
          label: "Wiki",
        },
      },
    ]);
    expect(t.subagents).toEqual({
      general: true,
      types: ["reviewer", "superpowers:implementer"],
      inline: [
        {
          name: "scout",
          description: "Finds files.",
          instructions: "Look around.",
          tools: ["Read", "Grep"],
          skills: ["pdf-tools"],
          model: "fast",
        },
      ],
    });
    expect(t.modelRef).toBe("anthropic/claude-x");
    expect(t.quickActions).toEqual([{ title: "Summarize", body: "Summarize the thread." }]);
    expect(t.instructionFiles).toEqual([{ name: "style.md", content: "Be brief." }]);
  });

  it("reads connector policies on both entry forms and an inline type without tools", () => {
    const t = parse(
      [
        "connectors:",
        "  - template: github",
        "    policies: { delete_repo: deny, create_issue: ask }",
        "  - needs: { protocol: openapi, endpoint: https://api.example.com, tools: [q], label: API }",
        "    policies: { q: ask }",
        "subagents:",
        "  inline:",
        "    - name: scout",
        "      description: Finds files.",
        "      instructions: Look around.",
        "      skills: []",
        "      model: fast",
        "    - name: thinker",
        "      description: Thinks.",
        "      instructions: Think.",
        "      tools: []",
        "      skills: []",
        "      model: inherit",
      ].join("\n"),
    );
    expect(t.connectors).toEqual([
      { template: "github", policies: { delete_repo: "deny", create_issue: "ask" } },
      {
        needs: {
          protocol: "openapi",
          endpoint: "https://api.example.com",
          tools: ["q"],
          label: "API",
        },
        policies: { q: "ask" },
      },
    ]);
    expect(t.subagents?.inline?.map((x) => x.tools ?? null)).toEqual([null, []]);
  });

  it("rejects malformed or over-limit connector policies", () => {
    expect(
      errorsOf(md(`${base}\nconnectors:\n  - template: github\n    policies: { x: allow }`)),
    ).toEqual([expect.stringContaining("connectors[0].policies")]);
    expect(
      errorsOf(
        md(
          `${base}\nconnectors:\n  - needs: { protocol: mcp, endpoint: e, tools: [], label: L }\n    policies: [x]`,
        ),
      ),
    ).toEqual([expect.stringContaining("connectors[0].policies")]);
    const many = Array.from(
      { length: AGENT_TEMPLATE_LIMITS.connectorTools + 1 },
      (_, i) => `t${i}: ask`,
    ).join(", ");
    expect(
      errorsOf(md(`${base}\nconnectors:\n  - template: github\n    policies: { ${many} }`)),
    ).toEqual([expect.stringContaining("connectors[0].policies")]);
  });

  it("leaves the new fields absent for an old file", () => {
    const t = parse("skills: [pdf-tools]");
    for (const k of [
      "selectedSkills",
      "connectors",
      "subagents",
      "modelRef",
      "quickActions",
      "instructionFiles",
    ]) {
      expect(k in t).toBe(false);
    }
  });

  it("rejects over-limit lists with the field path", () => {
    const names = Array.from({ length: 33 }, (_, i) => `s${i}`).join(", ");
    expect(errorsOf(md(`${base}\nselectedSkills: [${names}]`))).toEqual([
      expect.stringContaining("selectedSkills"),
    ]);
    const conns = Array.from({ length: 17 }, () => "  - template: a").join("\n");
    expect(errorsOf(md(`${base}\nconnectors:\n${conns}`))).toEqual([
      expect.stringContaining("connectors"),
    ]);
    const types = Array.from({ length: 17 }, (_, i) => `t${i}`).join(", ");
    expect(errorsOf(md(`${base}\nsubagents:\n  types: [${types}]`))).toEqual([
      expect.stringContaining("subagents"),
    ]);
    const inline = (i: number) =>
      `    - name: n${i}\n      description: d\n      instructions: x\n      tools: []\n      skills: []\n      model: fast`;
    const eight = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(inline).join("\n");
    expect(
      errorsOf(
        md(
          `${base}\nsubagents:\n  types: [${types.split(", ").slice(0, 8).join(", ")}]\n  inline:\n${eight}`,
        ),
      ),
    ).toEqual([expect.stringContaining("subagents")]);
  });

  it("rejects over-long inline instructions", () => {
    const front = `${base}\nsubagents:\n  inline:\n    - name: a\n      description: d\n      instructions: ${"x".repeat(100_001)}\n      tools: []\n      skills: []\n      model: fast`;
    expect(errorsOf(md(front))).toEqual([
      expect.stringContaining("subagents.inline[0].instructions"),
    ]);
  });

  it("rejects malformed entries with the field path", () => {
    expect(errorsOf(md(`${base}\nselectedSkills: [Not Valid]`))).toEqual([
      expect.stringContaining("selectedSkills"),
    ]);
    expect(errorsOf(md(`${base}\nconnectors:\n  - {}`))).toEqual([
      expect.stringContaining("connectors[0]"),
    ]);
    expect(
      errorsOf(
        md(`${base}\nconnectors:\n  - needs: { protocol: grpc, endpoint: x, tools: [], label: L }`),
      ),
    ).toEqual([expect.stringContaining("connectors[0].needs.protocol")]);
    expect(errorsOf(md(`${base}\nsubagents:\n  general: yes-please`))).toEqual([
      expect.stringContaining("subagents.general"),
    ]);
    expect(errorsOf(md(`${base}\nmodelRef: nomodel`))).toEqual([
      expect.stringContaining("modelRef"),
    ]);
    expect(errorsOf(md(`${base}\nquickActions:\n  - title: ""\n    body: b`))).toEqual([
      expect.stringContaining("quickActions[0]"),
    ]);
    expect(errorsOf(md(`${base}\ninstructionFiles:\n  - name: a`))).toEqual([
      expect.stringContaining("instructionFiles[0]"),
    ]);
  });

  it("rejects over-limit quick actions and instruction files", () => {
    const qa = (n: number) =>
      Array.from({ length: n }, () => "  - title: t\n    body: b").join("\n");
    expect(errorsOf(md(`${base}\nquickActions:\n${qa(10)}`))).toEqual([
      expect.stringContaining("quickActions"),
    ]);
    expect(
      errorsOf(md(`${base}\nquickActions:\n  - title: ${"x".repeat(41)}\n    body: b`)),
    ).toEqual([expect.stringContaining("quickActions[0]")]);
    const files = [0, 1]
      .map((i) => `  - name: f${i}.md\n    content: ${"x".repeat(60_000)}`)
      .join("\n");
    expect(errorsOf(md(`${base}\ninstructionFiles:\n${files}`))).toEqual([
      expect.stringContaining("instructionFiles must total"),
    ]);
    expect(errorsOf(md(`${base}\ninstructionFiles:\n  - name: a/b.md\n    content: c`))).toEqual([
      expect.stringContaining("instructionFiles[0]"),
    ]);
  });

  it("enforces the frontmatter cap at 2 MiB", () => {
    const pad = (n: number) => `${base}\nx: ${"a".repeat(n)}`;
    const cap = 2 * 1024 * 1024;
    const over = errorsOf(md(pad(cap)));
    expect(over).toEqual([expect.stringContaining("frontmatter must be at most")]);
    expect(errorsOf(md(pad(cap - base.length - 10)))).toEqual([]);
  });

  it("rejects empty inline instructions and duplicate names", () => {
    expect(
      errorsOf(
        md(
          `${base}\nsubagents:\n  inline:\n    - name: a\n      description: d\n      instructions: "  "\n      tools: []\n      skills: []\n      model: fast`,
        ),
      ),
    ).toEqual([expect.stringContaining("subagents.inline[0].instructions")]);
    expect(errorsOf(md(`${base}\nselectedSkills: [a, a]`))).toEqual([
      expect.stringContaining("selectedSkills"),
    ]);
    expect(errorsOf(md(`${base}\nskills: [a, a]`))).toEqual([expect.stringContaining("skills")]);
    expect(errorsOf(md(`${base}\nsubagents:\n  types: [a, a]`))).toEqual([
      expect.stringContaining("subagents.types"),
    ]);
  });
});

describe("AGENT_TEMPLATE_FIELDS", () => {
  it("lists exactly the frontmatter keys the parser reads", () => {
    const source = readFileSync(new URL("../src/agent-template.ts", import.meta.url), "utf8");
    const parserStart = source.indexOf("export function parseAgentTemplate");
    expect(parserStart).toBeGreaterThan(0);
    const read = new Set(
      [...source.slice(parserStart).matchAll(/\bfm\.([A-Za-z]+)/g)].map((m) => m[1]),
    );
    expect([...read].sort()).toEqual(AGENT_TEMPLATE_FIELDS.map((f) => f.name).sort());
  });
});
