import { describe, expect, it } from "vitest";
import { switchable, visibleTo, wantedOn } from "../../src/catalog/scope.js";

describe("plugin scope rules", () => {
  it.each([
    ["all", false, false, false, null, true],
    ["all", false, false, false, false, false], // an org may turn off `all` (layering spec §4)
    ["all", false, false, false, true, true],
    ["all", true, false, false, null, false], // disabled wins
    ["optional", false, false, false, null, false],
    ["optional", false, false, false, true, true],
    ["named", false, false, true, null, true], // default on for listed orgs
    ["named", false, false, true, false, false],
    ["named", false, false, false, true, false], // not listed: never on
    ["all", false, true, false, false, true], // builtin: on everywhere, switch ignored
    ["optional", false, true, false, false, true],
    ["named", true, false, true, null, false], // disabled wins over the list
  ] as const)(
    "%s disabled=%s builtin=%s listed=%s switch=%s -> %s",
    (scope, disabled, builtin, inList, sw, on) =>
      expect(wantedOn({ scope, disabled, builtin }, inList, sw)).toBe(on),
  );

  it("builtin without a scope of its own is on unless disabled", () => {
    expect(wantedOn({ scope: "optional", disabled: false, builtin: true }, false, null)).toBe(true);
    expect(wantedOn({ scope: "named", disabled: true, builtin: true }, true, null)).toBe(false);
  });

  it("named items are visible only to listed orgs", () => {
    expect(visibleTo({ scope: "named" }, false)).toBe(false);
    expect(visibleTo({ scope: "named" }, true)).toBe(true);
    expect(visibleTo({ scope: "all" }, false)).toBe(true);
    expect(visibleTo({ scope: "optional" }, false)).toBe(true);
  });

  it("only builtin items are not switchable", () => {
    expect(switchable({ scope: "all", builtin: false })).toBe(true);
    expect(switchable({ scope: "all", builtin: true })).toBe(false);
    expect(switchable({ scope: "optional", builtin: true })).toBe(false);
    expect(switchable({ scope: "optional", builtin: false })).toBe(true);
    expect(switchable({ scope: "named", builtin: false })).toBe(true);
  });
});
