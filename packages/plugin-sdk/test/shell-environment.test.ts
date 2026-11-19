import { describe, expect, expectTypeOf, it } from "vitest";
import { type CapybaraShell, SHELL_CAPABILITIES } from "../src/index.js";

describe("shell environment", () => {
  it("the envelope version is the literal 1", () => {
    expectTypeOf<CapybaraShell["version"]>().toEqualTypeOf<1>();
  });

  it("the capability registry lists the five known keys", () => {
    expect(SHELL_CAPABILITIES.map((c) => c.key)).toEqual([
      "device@1",
      "notify@1",
      "openExternal@1",
      "signIn@1",
      "chrome@1",
    ]);
    for (const c of SHELL_CAPABILITIES) expect(c.owner.length).toBeGreaterThan(0);
  });
});
