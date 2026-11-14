import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceRes, KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import { HostExecutor } from "../src/exec/host.js";
import { listDirectory, scanDirectory } from "../src/exec/listing.js";
import { SwitchingExecutor } from "../src/exec/switch.js";
import { DeviceOpError, type Executor } from "../src/exec/types.js";
import { PolicyStore } from "../src/policy-store.js";
import { type OpContext, runOp, serveOp } from "../src/server-ops.js";
import { DEFAULT_POLICY, type SandboxMode, writePolicy } from "../src/state.js";
import { execArgs, FakeExecutor } from "./fake-kernel.js";

/**
 * Stands in for the OS executor's sandboxed helper: reads the workspace only (the helper's own
 * rules are tested in fs-helper.test.ts and, in the real sandbox, exec-os.test.ts), and records
 * the modes it was asked to read in.
 */
class SandboxedReader extends FakeExecutor {
  readonly reads: SandboxMode[] = [];
  constructor(private readonly workspace: string) {
    super();
  }
  private inside(path: string): void {
    if (path !== this.workspace && !path.startsWith(`${this.workspace}/`)) {
      throw new DeviceOpError("policy", `${path} is outside the device's workspace`);
    }
  }
  async list(mode: SandboxMode, path: string, limit: number) {
    this.reads.push(mode);
    this.inside(path);
    return listDirectory(path, limit);
  }
  async scan(mode: SandboxMode, base: string) {
    this.reads.push(mode);
    this.inside(base);
    return scanDirectory(base);
  }
}

let tmp: string;
let home: string;
let state: string;
let workspace: string;
let sandboxed: SandboxedReader;
let host: HostExecutor;
let ex: SwitchingExecutor;
let store: PolicyStore;
const signal = new AbortController().signal;

const setMode = (mode: SandboxMode) => writePolicy(state, { ...DEFAULT_POLICY, mode });
const req = (op: KernelReq["op"], args: unknown): KernelReq => ({
  type: "req",
  id: "q",
  op,
  args,
  deadlineMs: 1000,
});
const list = (path: string, ceiling: SandboxMode, limit = 100) =>
  req("list", { path, limit, limits: { mode: ceiling } });
const scan = (base: string, ceiling: SandboxMode) =>
  req("scan", { base, limits: { mode: ceiling } });
const execUnder = (ceiling: SandboxMode) => {
  const a = execArgs("now");
  return req("exec", { ...a, limits: { ...a.limits, mode: ceiling } });
};
const ctx = (): OpContext => ({ policy: store, seen: {} });
const errorOf = (res: DeviceRes) => (res.ok ? undefined : res.error);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "device-read-")));
  home = join(tmp, "home");
  state = join(tmp, "state");
  mkdirSync(join(home, "code/core/.git"), { recursive: true });
  mkdirSync(join(home, "code/plain"), { recursive: true });
  mkdirSync(state);
  host = new HostExecutor({ dir: join(tmp, "env") });
  workspace = host.roots.workspace;
  mkdirSync(join(workspace, "proj"), { recursive: true });
  writeFileSync(join(workspace, "proj/AGENTS.md"), "");
  sandboxed = new SandboxedReader(workspace);
  store = new PolicyStore(state);
  ex = new SwitchingExecutor(sandboxed, host, () => store.current());
});
afterEach(() => {
  ex.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

describe("list and scan in the request's own ceiling", () => {
  it("owner on auto, ceiling sandbox, before any command: only the workspace is read", async () => {
    setMode("auto");
    const outside = await runOp(ex, list(join(home, "code"), "sandbox"), signal, ctx());
    expect(errorOf(outside)).toMatchObject({ kind: "policy" });
    expect(errorOf(await runOp(ex, scan(home, "sandbox"), signal, ctx()))).toMatchObject({
      kind: "policy",
    });
    expect(await runOp(ex, scan(workspace, "sandbox"), signal, ctx())).toMatchObject({
      ok: true,
      result: [{ path: join(workspace, "proj"), suggestedName: "proj" }],
    });
    expect(sandboxed.reads).toEqual(["sandbox", "sandbox", "sandbox"]);
  });

  it("owner on auto, ceiling auto: lists and scans the owner's home before any command", async () => {
    setMode("auto");
    expect(await runOp(ex, list(join(home, "code"), "auto"), signal, ctx())).toMatchObject({
      ok: true,
      result: {
        entries: [
          { name: "core", isDir: true },
          { name: "plain", isDir: true },
        ],
        truncated: false,
      },
    });
    expect(await runOp(ex, scan(home, "auto"), signal, ctx())).toMatchObject({
      ok: true,
      result: [{ path: join(home, "code/core"), suggestedName: "core" }],
    });
    expect(sandboxed.reads).toEqual([]);
  });

  it("owner on sandbox: a ceiling of auto still reads in the sandbox", async () => {
    setMode("sandbox");
    const res = await runOp(ex, list(join(home, "code"), "auto"), signal, ctx());
    expect(errorOf(res)).toMatchObject({ kind: "policy" });
    expect(sandboxed.reads).toEqual(["sandbox"]);
  });

  it("never follows the ceiling an earlier command saw", async () => {
    setMode("auto");
    const seen = ctx();
    // an exec under an auto ceiling, then a list under a sandbox ceiling: refused
    await runOp(ex, execUnder("auto"), signal, seen);
    expect(seen.seen?.limits).toEqual({ mode: "auto" });
    const refused = await runOp(ex, list(join(home, "code"), "sandbox"), signal, seen);
    expect(errorOf(refused)).toMatchObject({ kind: "policy" });
    // an exec under a sandbox ceiling, then a list under an auto ceiling: read as the owner
    await runOp(ex, execUnder("sandbox"), signal, seen);
    expect(await runOp(ex, list(join(home, "code"), "auto"), signal, seen)).toMatchObject({
      ok: true,
    });
  });

  it("answers while the device directory is gone", async () => {
    setMode("auto");
    expect(await host.ensureRoot()).toBe("ok");
    rmSync(join(tmp, "env"), { recursive: true, force: true });
    sandboxed.root = "gone"; // what the OS executor's guard says once the directory vanished
    expect(await runOp(ex, list(join(home, "code"), "auto"), signal, ctx())).toMatchObject({
      ok: true,
    });
    // the workspace is gone with it: nothing to scan, nothing to list
    expect(await runOp(ex, scan(workspace, "sandbox"), signal, ctx())).toMatchObject({
      ok: true,
      result: [],
    });
    expect(await runOp(ex, list(workspace, "sandbox"), signal, ctx())).toMatchObject({
      ok: true,
      result: null,
    });
    // other operations still answer fs_gone
    expect(errorOf(await runOp(ex, req("stat", { path: workspace }), signal, ctx()))).toMatchObject(
      { kind: "fs_gone" },
    );
  });

  it("answers null for a missing path and an error for a file", async () => {
    setMode("auto");
    writeFileSync(join(home, "notes.txt"), "x");
    expect(await runOp(ex, list(join(home, "none"), "auto"), signal, ctx())).toMatchObject({
      ok: true,
      result: null,
    });
    expect(errorOf(await runOp(ex, list(join(home, "notes.txt"), "auto"), signal, ctx()))).toEqual({
      kind: "error",
      message: `${join(home, "notes.txt")} is not a directory`,
    });
  });

  it("logs each request locally with the mode it was read in", async () => {
    setMode("auto");
    const log = new CommandLog(state);
    for (const r of [list(join(home, "code"), "auto"), list(join(home, "code"), "sandbox")]) {
      const { res, detail } = await serveOp(ex, r, signal, ctx());
      log.append({
        time: new Date().toISOString(),
        op: r.op,
        tag: null,
        actor: null,
        exitCode: null,
        ...(detail !== undefined && { detail }),
      });
      expect(res.ok).toBe(
        r.args && (r.args as { limits: { mode: string } }).limits.mode === "auto",
      );
    }
    const lines = readFileSync(join(state, "commands.log"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string).detail).toBe(`list ${join(home, "code")} in auto mode`);
    expect(JSON.parse(lines[1] as string).detail).toMatch(/^list refused: .*outside/);
  });
});

describe("list and scan requests the device does not serve or refuses", () => {
  it("are unsupported without a policy store or an executor that can read in a mode", async () => {
    for (const [executor, c] of [
      [ex, {}],
      [new FakeExecutor(), { policy: store }],
    ] as [Executor, OpContext][]) {
      for (const r of [list(home, "auto"), scan(home, "auto")]) {
        expect(errorOf(await runOp(executor, r, signal, c))).toEqual({
          kind: "error",
          message: "unsupported operation",
        });
      }
    }
  });

  it("refuses invalid arguments the frame parser would have refused", async () => {
    setMode("auto");
    for (const r of [
      req("list", { path: home, limit: 0, limits: { mode: "auto" } }),
      req("list", { path: home, limit: 1001, limits: { mode: "auto" } }),
      req("list", { path: "code", limit: 1, limits: { mode: "auto" } }),
      req("list", { path: `${home}/../etc`, limit: 1, limits: { mode: "auto" } }),
      req("list", { path: home, limit: 1, limits: { mode: "open" } }),
      req("list", { path: home, limit: 1 }),
      req("scan", { base: 7, limits: { mode: "auto" } }),
    ]) {
      expect(errorOf(await runOp(ex, r, signal, ctx())), JSON.stringify(r.args)).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/^invalid request/),
      });
    }
  });
});
