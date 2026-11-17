import {
  type SandboxOperation,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionEndpoint,
  type SandboxPermissionFixture,
  waitForFile,
} from "../src/sandbox-permission-conformance.js";

function unsupportedFixture(
  operation: () => Promise<SandboxOperation>,
  granted: Partial<SandboxPermissionEndpoint> = {},
) {
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
      granted: {
        name: "granted.permission.test",
        address: "127.0.0.1",
        port: 1,
        receipts: unexpected,
        ...granted,
      },
      ungranted: [],
      access: "direct",
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

  it("rejects an endpoint whose allowlist name no valid scope could carry", async () => {
    // validateAllowHost refuses IP literals: a granted name of 127.0.0.1 could never be allowlisted.
    const { fixture, disposed } = unsupportedFixture(
      async () => {
        throw new SandboxPermissionUnsupportedError("restricted unavailable");
      },
      { name: "127.0.0.1" },
    );
    await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(
      /granted endpoint name 127\.0\.0\.1 is not a valid allowlist host/,
    );
    expect(disposed()).toBe(true);
  });

  it("rejects an endpoint address that is not numeric", async () => {
    const { fixture } = unsupportedFixture(
      async () => {
        throw new SandboxPermissionUnsupportedError("restricted unavailable");
      },
      { address: "granted.permission.test" },
    );
    await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(
      /granted endpoint address .* is not a numeric address/,
    );
  });
});

describe("waitForFile", () => {
  const never = new Promise<never>(() => {});

  it("returns once the file appears", async () => {
    let reads = 0;
    await waitForFile(async () => (++reads < 3 ? null : new Uint8Array()), "/r/ready", never);
    expect(reads).toBe(3);
  });

  it("fails with the operation's error when the operation is refused first", async () => {
    const refused = Promise.reject(new SandboxPermissionUnsupportedError("refused here"));
    await expect(waitForFile(async () => null, "/r/ready", refused)).rejects.toThrow(
      /operation ended before \/r\/ready existed: .*refused here/,
    );
  });

  it("fails promptly when the operation exits without writing the file", async () => {
    const exited = Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: "no such file",
      truncated: false,
      timedOut: false,
    });
    await expect(waitForFile(async () => null, "/r/ready", exited)).rejects.toThrow(
      /operation ended before \/r\/ready existed: exit 2: no such file/,
    );
  });

  it("accepts a file the operation wrote just before it ended", async () => {
    let reads = 0;
    const ended = Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    // The first read misses, the operation has ended by the check, a final read sees the file.
    await waitForFile(
      async () => {
        await ended;
        return ++reads < 2 ? null : new Uint8Array();
      },
      "/r/ready",
      ended,
    );
    expect(reads).toBe(2);
  });
});
