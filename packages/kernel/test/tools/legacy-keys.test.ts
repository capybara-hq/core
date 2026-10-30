import { describe, expect, it } from "vitest";
import { needsLegacyScope, normalizeToolKeys } from "../../src/agents/definition.js";
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
      // todo__x is ambiguous (a connector slug and an extension name): it stays
      toolPolicies: {
        Bash: "ask",
        mcp__docs__search: "deny",
        plugin__board__move: "ask",
        todo__x: "ask",
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
