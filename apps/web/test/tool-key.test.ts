import { describe, expect, it } from "vitest";
import {
  connectorToolKey,
  extensionToolKey,
  type ParsedToolKey,
  parseToolKey,
} from "../src/lib/tool-key";

const VECTORS: Array<[string, ParsedToolKey | null]> = [
  ["Bash", { kind: "builtin", name: "Bash" }],
  ["sandbox_bash", null],
  ["bash", null],
  ["Ba_sh", null],
  ["mcp__crm__search_accounts", { kind: "connector", slug: "crm", tool: "search_accounts" }],
  ["mcp__crm__list_resources", { kind: "connector", slug: "crm", tool: "list_resources" }],
  ["plugin__todo__write", { kind: "extension", plugin: "todo", tool: "write" }],
  ["plugin__object-store-s3__x", { kind: "extension", plugin: "object-store-s3", tool: "x" }],
  ["mcp__plugin__x", { kind: "connector", slug: "plugin", tool: "x" }],
  ["docs__search", null],
  ["mcp____x", null],
  ["plugin__a", null],
];

describe("parseToolKey", () => {
  it.each(VECTORS)("%s", (key, expected) => {
    expect(parseToolKey(key)).toEqual(expected);
  });

  it("round-trips builders", () => {
    for (const [key, parsed] of VECTORS) {
      if (parsed?.kind === "connector")
        expect(connectorToolKey(parsed.slug, parsed.tool)).toBe(key);
      if (parsed?.kind === "extension")
        expect(extensionToolKey(parsed.plugin, parsed.tool)).toBe(key);
    }
    expect(connectorToolKey("crm", "search")).toBe("mcp__crm__search");
  });
});
