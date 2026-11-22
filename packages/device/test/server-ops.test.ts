import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KernelRequest, parseDeviceFrame } from "@capybara-hq/plugin-sdk/device-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { PROJECT_REFUSAL_MESSAGES } from "../src/exec/operation-types.js";
import { DeviceProjectRefusedError } from "../src/exec/types.js";
import { policySummary, serveOperationV3 } from "../src/server-ops.js";
import { DEFAULT_POLICY, type OwnerCeilingPolicy } from "../src/state.js";

const FULL_OWNER_CEILING: OwnerCeilingPolicy = {
  outsideSandbox: true,
  network: "open",
  projectReach: "machine",
};

/** The policy these tests were written against: outside the sandbox on, the open network. */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };

describe("CommandLog", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rotates at the size limit", () => {
    dir = mkdtempSync(join(tmpdir(), "device-log-"));
    writeFileSync(join(dir, "commands.log"), "x".repeat(100));
    const log = new CommandLog(dir, 100);
    log.append({ time: "t", op: "exec", tag: "a", actor: null, exitCode: 0 });
    expect(readFileSync(join(dir, "commands.log.1"), "utf8")).toBe("x".repeat(100));
    expect(readFileSync(join(dir, "commands.log"), "utf8")).toContain('"op":"exec"');
  });
});

describe("the policy summary", () => {
  it("reports the sandbox allowlist and the shared project directories, on the machine and in a container", () => {
    expect(
      policySummary(
        {
          ...FULL_POLICY,
          ownerCeiling: { outsideSandbox: true, network: "open", projectReach: "machine" },
        },
        { mode: "os", sharedProjectRoots: ["/p/shared"] },
      ),
    ).toEqual({ allowedDomains: [], sharedProjectRoots: ["/p/shared"] });
    expect(
      policySummary(
        {
          ...FULL_POLICY,
          ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
        },
        { mode: "docker", sharedProjectRoots: [] },
      ),
    ).toEqual({ allowedDomains: [], sharedProjectRoots: [] });
  });
});

describe("project refusals", () => {
  it("answers a project refusal as project_refused with its code", async () => {
    const message = PROJECT_REFUSAL_MESSAGES["outside-reach"];
    const backend = {
      browse: async () => ({
        list: async () => {
          throw new DeviceProjectRefusedError("outside-reach", message);
        },
      }),
    } as unknown as MacOperationBackend;
    const scope = {
      operationId: "browse",
      admitBeforeMs: 1000,
      deviceId: "d",
      accountId: "a",
      ceilingRevision: "c",
      readRoots: ["/elsewhere"],
      tag: "browse",
    };
    const response = await serveOperationV3(
      backend,
      { id: "d" },
      {
        type: "req",
        id: "request",
        op: "browseList",
        args: { scope, path: "/elsewhere", limit: 10 },
        deadlineMs: 1000,
      } as KernelRequest,
      new AbortController().signal,
    );
    expect(response).toEqual({
      type: "res",
      id: "request",
      ok: false,
      error: { kind: "project_refused", refusal: "outside-reach", message },
    });
    if (response.ok) throw new Error("expected a refusal");
    expect(parseDeviceFrame({ ok: response.ok, error: response.error }, "res")).toEqual({
      ok: false,
      error: { kind: "project_refused", refusal: "outside-reach", message },
    });
  });
});
