import {
  type SandboxOperation,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionFixture,
} from "../src/sandbox-permission-conformance.js";

function unsupportedFixture(operation: () => Promise<SandboxOperation>) {
  let disposed = false;
  const support: SandboxPermissionSupport = {
    version: 1,
    restricted: null,
    fullAccess: true,
    background: false,
    unavailableReason: "test runtime without restricted primitives",
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected fixture call");
  };
  const fixture: SandboxPermissionFixture = {
    root: "/owned/root",
    sibling: "/owned/sibling",
    protectedPaths: [],
    endpoints: {
      granted: { host: "127.0.0.1", port: 1, receipts: unexpected },
      ungranted: [],
    },
    support: async () => support,
    operation,
    seed: unexpected,
    inspect: { readFile: unexpected, mode: unexpected, alive: unexpected },
    dispose: async () => {
      disposed = true;
    },
  };
  return { fixture, disposed: () => disposed };
}

describe("permission conformance harness", () => {
  it("accepts an unsupported runtime only when restricted operations fail closed", async () => {
    const { fixture, disposed } = unsupportedFixture(async () => {
      throw new SandboxPermissionUnsupportedError("restricted unavailable");
    });
    await runSandboxPermissionConformance(fixture);
    expect(disposed()).toBe(true);
  });

  it("rejects an unsupported runtime that still runs restricted commands", async () => {
    const { fixture, disposed } = unsupportedFixture(async () => ({
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      }),
      readFile: async () => null,
      writeFile: async () => {},
      stat: async () => null,
    }));
    await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(/refuse restricted/);
    expect(disposed()).toBe(true);
  });
});
