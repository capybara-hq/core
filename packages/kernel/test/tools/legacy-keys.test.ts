import { describe, expect, it } from "vitest";
import {
  needsLegacyScope,
  normalizeStoredDefinition,
  normalizeToolKeys,
} from "../../src/agents/definition.js";
import {
  deriveInstructions,
  joinInstructionFiles,
  readInstructionFiles,
} from "../../src/agents/instruction-files.js";
import {
  LEGACY_BUILTINS,
  legacyHint,
  legacyKeySaveText,
  legacyToolInput,
  legacyToolKey,
} from "../../src/tools/legacy-keys.js";

const both = {
  connectorSlugs: new Set(["todo", "docs"]),
  extensionNames: new Set(["todo", "probe"]),
};

describe("legacyToolKey", () => {
  it("maps every old builtin to its new name, without a scope", () => {
    for (const [old, { name }] of Object.entries(LEGACY_BUILTINS)) {
      expect(legacyToolKey(old)).toBe(name);
    }
    expect(legacyToolKey("sandbox_bash")).toBe("Bash");
  });

  it("maps <x>__<tool> by the scope that owns x; ambiguous or unknown -> null", () => {
    expect(legacyToolKey("todo__write", both)).toBeNull();
    expect(
      legacyToolKey("todo__write", {
        connectorSlugs: new Set(),
        extensionNames: new Set(["todo"]),
      }),
    ).toBe("plugin__todo__write");
    expect(legacyToolKey("docs__read", both)).toBe("mcp__docs__read");
    expect(legacyToolKey("nope__read", both)).toBeNull();
    expect(legacyToolKey("docs__read")).toBeNull();
  });

  it("returns null for a new key", () => {
    expect(legacyToolKey("Bash", both)).toBeNull();
    expect(legacyToolKey("mcp__docs__read", both)).toBeNull();
    expect(legacyToolKey("plugin__todo__write", both)).toBeNull();
  });
});

describe("legacyToolInput", () => {
  it("renames parameters", () => {
    expect(
      legacyToolInput("sandbox_edit", { path: "/a", oldText: "x", newText: "y", replaceAll: true }),
    ).toEqual({ file_path: "/a", old_string: "x", new_string: "y", replace_all: true });
    expect(legacyToolInput("skill_load", { name: "s" })).toEqual({ skill: "s" });
  });

  it("converts seconds to milliseconds for msParams", () => {
    expect(legacyToolInput("sandbox_bash", { command: "ls", timeoutSeconds: 3 })).toEqual({
      command: "ls",
      timeout: 3000,
    });
  });

  it("passes other keys, non-objects and non-builtin keys through", () => {
    expect(legacyToolInput("sandbox_glob", { pattern: "*" })).toEqual({ pattern: "*" });
    expect(legacyToolInput("sandbox_read", "x")).toBe("x");
    expect(legacyToolInput("todo__write", { path: 1 })).toEqual({ path: 1 });
  });
});

describe("legacyHint", () => {
  it("names the new tool and its parameters", () => {
    expect(legacyHint("sandbox_bash")).toBe(
      'Tool "sandbox_bash" no longer exists; it is now "Bash" (parameters: command, description, timeout in milliseconds).',
    );
    expect(legacyHint("sandbox_glob")).toBe(
      'Tool "sandbox_glob" no longer exists; it is now "Glob".',
    );
  });

  it("is null for anything that is not an old builtin", () => {
    expect(legacyHint("Bash")).toBeNull();
    expect(legacyHint("todo__write")).toBeNull();
  });
});

describe("normalizeToolKeys (stored definitions and templates)", () => {
  const scope = {
    connectorSlugs: new Set(["docs", "todo"]),
    extensionNames: new Set(["todo", "board"]),
  };

  it("maps builtin refs, policy keys and inline templates; scoped keys only with a scope", () => {
    const def = {
      name: "x",
      tools: [
        { kind: "builtin", name: "sandbox_bash" },
        { kind: "builtin", name: "Read" },
        { kind: "connector", connectorId: "c1", tools: ["search"] },
      ],
      toolPolicies: {
        sandbox_bash: "ask",
        docs__search: "deny",
        board__move: "ask",
        todo__x: "ask",
      },
      subagents: {
        general: false,
        inline: [{ name: "r", tools: ["sandbox_read", "Read"], disallowedTools: ["docs__search"] }],
      },
    };
    expect(normalizeToolKeys(def)).toEqual({
      ...def,
      tools: [
        { kind: "builtin", name: "Bash" },
        { kind: "builtin", name: "Read" },
        { kind: "connector", connectorId: "c1", tools: ["search"] },
      ],
      toolPolicies: { Bash: "ask", docs__search: "deny", board__move: "ask", todo__x: "ask" },
      subagents: {
        general: false,
        inline: [{ name: "r", tools: ["Read"], disallowedTools: ["docs__search"] }],
      },
    });
    expect(normalizeToolKeys(def, scope)).toMatchObject({
      // todo__x is ambiguous (a connector slug and an extension name) and the definition refs
      // neither: the ask is kept on both candidates
      toolPolicies: {
        Bash: "ask",
        mcp__docs__search: "deny",
        plugin__board__move: "ask",
        mcp__todo__x: "ask",
        plugin__todo__x: "ask",
      },
      subagents: { inline: [{ tools: ["Read"], disallowedTools: ["mcp__docs__search"] }] },
    });
    expect(needsLegacyScope(def)).toBe(true);
  });

  it("keeps current keys and returns the same object when nothing changes", () => {
    const def = {
      tools: [{ kind: "builtin", name: "Bash" }],
      toolPolicies: { Bash: "ask", mcp__docs__search: "deny", plugin__todo__x: "ask" },
    };
    expect(normalizeToolKeys(def, scope)).toBe(def);
    expect(needsLegacyScope(def)).toBe(false);
    // a slug named like the prefix never re-maps a current key
    const tricky = { connectorSlugs: new Set(["mcp"]), extensionNames: new Set(["plugin"]) };
    expect(normalizeToolKeys(def, tricky)).toBe(def);
  });

  it("two keys that become one keep the stricter policy", () => {
    expect(normalizeToolKeys({ toolPolicies: { sandbox_bash: "deny", Bash: "ask" } })).toEqual({
      toolPolicies: { Bash: "deny" },
    });
    expect(normalizeToolKeys({ toolPolicies: { Bash: "ask", sandbox_bash: "ask" } })).toEqual({
      toolPolicies: { Bash: "ask" },
    });
  });

  it("an ambiguous key (slug and extension name): the definition's own refs decide, else a deny is kept on both", () => {
    const scoped = { ...scope, connectorSlugById: new Map([["c-todo", "todo"]]) };
    // refs the connector todo only
    expect(
      normalizeToolKeys(
        {
          tools: [{ kind: "connector", connectorId: "c-todo", tools: "all" }],
          toolPolicies: { todo__x: "deny" },
        },
        scoped,
      ),
    ).toMatchObject({ toolPolicies: { mcp__todo__x: "deny" } });
    // refs the extension todo only
    expect(
      normalizeToolKeys(
        {
          tools: [{ kind: "plugin", plugin: "todo", name: "x" }],
          toolPolicies: { todo__x: "ask" },
        },
        scoped,
      ),
    ).toMatchObject({ toolPolicies: { plugin__todo__x: "ask" } });
    // both or neither: ask / deny on both candidates, anything else dropped
    const both = {
      tools: [
        { kind: "connector", connectorId: "c-todo", tools: "all" },
        { kind: "plugin", plugin: "todo", name: "x" },
      ],
      toolPolicies: { todo__x: "deny" },
    };
    expect((normalizeToolKeys(both, scoped) as { toolPolicies: unknown }).toolPolicies).toEqual({
      mcp__todo__x: "deny",
      plugin__todo__x: "deny",
    });
    expect(
      (
        normalizeToolKeys(
          { tools: [], toolPolicies: { todo__x: "ask", todo__y: "allow" } },
          scoped,
        ) as {
          toolPolicies: unknown;
        }
      ).toolPolicies,
    ).toEqual({ mcp__todo__x: "ask", plugin__todo__x: "ask" });
    // an inline template reads its parent's refs; its deny list keeps both, its allowlist the old key
    const parent = {
      tools: [{ kind: "plugin", plugin: "todo", name: "x" }],
      subagents: {
        inline: [{ name: "a", toolPolicies: { todo__x: "deny" }, disallowedTools: ["todo__y"] }],
      },
    };
    expect(normalizeToolKeys(parent, scoped)).toMatchObject({
      subagents: {
        inline: [
          { toolPolicies: { plugin__todo__x: "deny" }, disallowedTools: ["plugin__todo__y"] },
        ],
      },
    });
    expect(normalizeToolKeys({ tools: ["todo__x"], disallowedTools: ["todo__y"] }, scoped)).toEqual(
      { tools: ["todo__x"], disallowedTools: ["mcp__todo__y", "plugin__todo__y"] },
    );
    // a template naming the extension's current key disambiguates its other keys
    expect(normalizeToolKeys({ tools: ["plugin__todo__x", "todo__y"] }, scoped)).toEqual({
      tools: ["plugin__todo__x", "plugin__todo__y"],
    });
  });

  it("names the new key(s) when an rc key is saved", () => {
    expect(legacyKeySaveText("sandbox_read")).toBe(
      '"sandbox_read" is a release-candidate tool key; use "Read"',
    );
    expect(legacyKeySaveText("docs__search", new Set(["mcp__docs__search"]))).toBe(
      '"docs__search" is a release-candidate tool key; use "mcp__docs__search"',
    );
    expect(legacyKeySaveText("docs__search")).toBe(
      '"docs__search" is a release-candidate tool key; use "mcp__docs__search" or "plugin__docs__search"',
    );
    expect(legacyKeySaveText("Read")).toBeNull();
    expect(legacyKeySaveText("mcp__docs__search")).toBeNull();
  });
});

describe("prompt files and the stored-definition tool key normalization", () => {
  // a stored definition from the release candidate: old tool keys and named prompt files
  const files = [
    { name: "AGENTS.md", content: "a" },
    { name: "B.md", content: "b" },
  ];
  const stored = {
    name: "Old",
    instructions: joinInstructionFiles(files),
    instructionFiles: files,
    model: { provider: "model-fake", model: "fake-1" },
    tools: [
      { kind: "builtin", name: "ask_user" },
      { kind: "connector", connectorId: "cn1", tools: "all" },
    ],
    toolPolicies: { sandbox_bash: "ask", tracker__find: "deny" },
    disallowedTools: ["tracker__drop"],
  };
  const scope = {
    connectorSlugs: new Set(["tracker"]),
    extensionNames: new Set<string>(),
    connectorSlugById: new Map([["cn1", "tracker"]]),
  };

  it("normalizing the keys keeps the prompt files and the joined instructions", () => {
    const d = normalizeStoredDefinition(stored, scope);
    // the rc enabled list reads as nothing turned off (tools default-on spec §2); its connector
    // ref still disambiguates the rc policy keys
    expect((d as { tools?: unknown }).tools).toBeUndefined();
    expect(d.disabledTools).toEqual([]);
    expect(d.toolPolicies).toEqual({ Bash: "ask", mcp__tracker__find: "deny" });
    expect((d as { disallowedTools?: unknown }).disallowedTools).toEqual(["mcp__tracker__drop"]);
    expect(d.instructionFiles).toEqual(files);
    expect(d.instructions).toBe(stored.instructions);
    expect(readInstructionFiles(d)).toEqual(files);
  });

  it("an invalid stored attribution mode reads as inherit, keeping the other fields", () => {
    // stored data is not re-validated: the kernel and the agent page both read it as inherit
    const bogus = normalizeStoredDefinition(
      { ...stored, attribution: { mode: "bogus", commit: "Co-Authored-By: X" } },
      scope,
    );
    expect(bogus.attribution).toEqual({ mode: "inherit", commit: "Co-Authored-By: X" });
    // a valid mode is kept as it is
    for (const mode of ["inherit", "custom", "off"] as const) {
      const d = normalizeStoredDefinition({ ...stored, attribution: { mode } }, scope);
      expect(d.attribution).toEqual({ mode });
    }
  });

  it("a save re-sending the joined text over a normalized current version keeps the files", () => {
    const current = normalizeStoredDefinition(stored, scope);
    const saved = deriveInstructions(
      {
        name: "Old",
        instructions: stored.instructions,
        model: { provider: "model-fake", model: "fake-1" },
      } as Parameters<typeof deriveInstructions>[0],
      current,
    );
    expect(saved.instructionFiles).toEqual(files);
    expect(saved.instructions).toBe(stored.instructions);
  });
});
