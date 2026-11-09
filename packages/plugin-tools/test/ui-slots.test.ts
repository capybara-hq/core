import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginPack } from "../src/check/plugin-pack.js";
import { errorsOf } from "../src/check/source.js";
import { uiSlotFindings } from "../src/check/ui-slots.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("UI slot findings", () => {
  it("an unknown slot is ui-slot-unknown", async () => {
    const f = await checkPluginPack([fixture("plugin-ui-unknown-slot")]);
    expect(f.map((x) => x.rule)).toEqual(["ui-slot-unknown"]);
    expect(f[0]?.message).toBe(
      'ui "tasks" names slot conversation.nope, which this SDK does not know (unknown-slot); the host would drop it',
    );
  });

  it("an after that is no anchor is ui-slot-anchor and lists the anchors", async () => {
    const f = await checkPluginPack([fixture("plugin-ui-anchor")]);
    expect(f.map((x) => x.rule)).toEqual(["ui-slot-anchor"]);
    expect(f[0]?.message).toContain("context, files, background");
  });

  it("place is a warning that names the slot", async () => {
    const f = await checkPluginPack([fixture("plugin-ui-place")]);
    expect(f.map((x) => x.rule)).toEqual(["ui-place-deprecated"]);
    expect(f[0]?.severity).toBe("warning");
    expect(f[0]?.message).toBe(
      'ui "tasks" uses place "conversation"; write slot: "conversation.panel"',
    );
    expect(errorsOf(f)).toEqual([]);
  });

  it("a clean plugin has no findings", async () => {
    expect(await checkPluginPack([fixture("plugin-ui-slots-clean")])).toEqual([]);
  });

  it("ignores a missing or malformed ui", () => {
    expect(uiSlotFindings("f", undefined)).toEqual([]);
    expect(uiSlotFindings("f", "x")).toEqual([]);
  });
});
