import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelRequest } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { PolicyStore } from "../src/policy-store.js";
import { serveOperationV3 } from "../src/server-ops.js";
import { policyOpsPath } from "../src/state.js";

/** Closing the policy lock's file fails (EIO) once the lock was taken: `fn` has already run. */
let failClose = false;
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    closeSync: (fd: number) => {
      if (failClose) throw new Error("EIO");
      fs.closeSync(fd);
    },
  };
});

const source = { accountId: "acc_1", accountName: "Ada", via: "web" as const };
const req = (args: unknown) =>
  ({ type: "req", id: "x", op: "policy", args, deadlineMs: 1000 }) as KernelRequest;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-policy-lock-close-"));
});
afterEach(() => {
  failClose = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("the policy lock's release", () => {
  it("a failed close after the write leaves the op applied", async () => {
    const store = new PolicyStore(dir);
    failClose = true;
    const report = {
      version: 3 as const,
      sequence: 0,
      revision: "rev",
      outsideSandbox: false,
      network: "allowlist" as const,
      restrictedProjectReach: "workspace" as const,
      allowedDomains: [],
    };
    const res = await serveOperationV3(
      {} as MacOperationBackend,
      { id: "dev" },
      req({ opId: "op_1", remove: ["a.com"], source }),
      new AbortController().signal,
      undefined,
      { store, report: () => report, reconcile: async () => {} },
    );
    expect(res).toMatchObject({ ok: true, result: { policy: { allowedDomains: [] } } });
    expect(JSON.parse(readFileSync(policyOpsPath(dir), "utf8"))).toEqual([
      { opId: "op_1", outcome: "applied", time: expect.any(String) },
    ]);
  });
});
