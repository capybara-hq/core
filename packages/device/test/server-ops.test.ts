import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import { DeviceOpError } from "../src/exec/types.js";
import { runOp } from "../src/server-ops.js";
import { execArgs, FakeExecutor } from "./fake-kernel.js";

const r = (op: KernelReq["op"], args: unknown): KernelReq => ({
  type: "req",
  id: "x",
  op,
  args,
  deadlineMs: 1000,
});

describe("runOp", () => {
  it("maps an executor failure to an error answer, keeping a DeviceOpError kind", async () => {
    const ex = new FakeExecutor();
    ex.stat = async () => {
      throw new DeviceOpError("policy", "blocked by local policy");
    };
    const res = await runOp(ex, r("stat", { path: "/p" }), new AbortController().signal);
    expect(res).toEqual({
      type: "res",
      id: "x",
      ok: false,
      error: { kind: "policy", message: "blocked by local policy" },
    });
    ex.stat = async () => {
      throw new Error("boom");
    };
    expect(await runOp(ex, r("stat", { path: "/p" }), new AbortController().signal)).toMatchObject({
      error: { kind: "error", message: "boom" },
    });
  });

  it("answers stop without touching the root", async () => {
    const ex = new FakeExecutor();
    ex.root = "gone";
    expect(await runOp(ex, r("stop", { reason: "deleted" }), new AbortController().signal)).toEqual(
      {
        type: "res",
        id: "x",
        ok: true,
        result: null,
      },
    );
  });

  it("runs an exec through the executor", async () => {
    const res = await runOp(
      new FakeExecutor(),
      r("exec", execArgs("now")),
      new AbortController().signal,
    );
    expect(res).toMatchObject({ ok: true, result: { exitCode: 0 } });
  });
});

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
