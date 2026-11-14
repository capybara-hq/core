import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyStore } from "../src/policy-store.js";
import { serveOp } from "../src/server-ops.js";
import { policyOpsPath } from "../src/state.js";
import { FakeExecutor } from "./fake-kernel.js";

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
const req = (args: unknown): KernelReq => ({
  type: "req",
  id: "x",
  op: "policy",
  args,
  deadlineMs: 1000,
});

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
    const { res } = await serveOp(
      new FakeExecutor(),
      req({ opId: "op_1", add: ["a.com"], source }),
      new AbortController().signal,
      { policy: store },
    );
    expect(res).toMatchObject({ ok: true, result: { policy: { allowedDomains: ["a.com"] } } });
    expect(JSON.parse(readFileSync(policyOpsPath(dir), "utf8"))).toEqual([
      { opId: "op_1", outcome: "applied", time: expect.any(String) },
    ]);
  });
});
