import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginToolKeys } from "../src/check/plugin-tool-keys.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("plugin-tool-key-length", () => {
  it("a 40-character tool name under a long extension name fails with the computed length", () => {
    const f = checkPluginToolKeys([fixture("plugin-tool-key-long")]);
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe("plugin-tool-key-length");
    // plugin__ (8) + example-very-long-plugin-name (29) + __ (2) + 40
    expect(f[0]?.message).toContain("is 79 characters");
    expect(f[0]?.message).toContain("plugin__example-very-long-plugin-name__a_tool_name");
  });

  it("a name that is not a literal cannot be confirmed; the marker with a reason allows it", () => {
    const f = checkPluginToolKeys([fixture("plugin-tool-key-dynamic")]);
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("Cannot statically confirm");
  });

  it("todo passes", () => {
    expect(checkPluginToolKeys([fixture("plugin-tool-key-clean")])).toEqual([]);
  });
});
