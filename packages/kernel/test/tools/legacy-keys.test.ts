import { describe, expect, it } from "vitest";
import {
  LEGACY_BUILTINS,
  legacyHint,
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
