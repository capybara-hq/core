import { describe, expect, it } from "vitest";
import {
  runSandboxNativeConformance,
  type SandboxNativeFixture,
} from "../src/sandbox-native-conformance.js";

function incorrectFixture() {
  let disposed = false;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected native call before the missing-stat assertion");
  };
  const fixture: SandboxNativeFixture = {
    root: "/owned-fixture",
    operation: async () => ({
      stat: async () => ({ size: 999, isDir: false }),
      readFile: unexpected,
      writeFile: unexpected,
      list: unexpected,
      scan: unexpected,
    }),
    seed: async () => {},
    dispose: async () => {
      disposed = true;
    },
  };
  return { fixture, disposed: () => disposed };
}

describe("native conformance harness", () => {
  it("catches an intentionally wrong ordinary stat return and disposes on failure", async () => {
    const { fixture, disposed } = incorrectFixture();
    await expect(runSandboxNativeConformance(fixture)).rejects.toThrow(/missing stat/);
    expect(disposed()).toBe(true);
  });

  it("requires list and scan before invoking native methods", async () => {
    const { fixture, disposed } = incorrectFixture();
    const operation = fixture.operation;
    fixture.operation = async () => {
      const { list: _list, scan: _scan, ...rest } = await operation();
      return rest;
    };
    await expect(runSandboxNativeConformance(fixture)).rejects.toThrow(/list and scan/);
    expect(disposed()).toBe(true);
  });
});
