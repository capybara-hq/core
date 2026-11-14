import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SwitchingExecutor } from "../src/exec/switch.js";
import { DeviceOpError } from "../src/exec/types.js";
import { PolicyStore } from "../src/policy-store.js";
import { policySummary, type SeenState, serveOp, summaryFacts } from "../src/server-ops.js";
import { DEFAULT_POLICY, type Policy, policyPath, readPolicy, writePolicy } from "../src/state.js";
import { FakeExecutor, ROOTS } from "./fake-kernel.js";

const never = new AbortController().signal;

/** A project the fixture policy serves, inside the fake executor's workspace. */
const CORE = join(ROOTS.workspace, "core");

/** A request for one of the project operations. */
const r = (op: KernelReq["op"], args: unknown = {}): KernelReq => ({
  type: "req",
  id: "r1",
  op,
  args,
  deadlineMs: 1000,
});

describe("project operations", () => {
  let dir: string;
  let home: string;
  let store: PolicyStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-projects-ops-"));
    home = mkdtempSync(join(tmpdir(), "device-projects-home-"));
    writePolicy(dir, {
      ...DEFAULT_POLICY,
      mode: "sandbox",
      projects: [{ name: "core", path: CORE }],
    });
    store = new PolicyStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the projects the policy serves, and the summary reports them", async () => {
    const ex = new FakeExecutor();
    const ctx = { policy: store };
    const { res } = await serveOp(ex, r("projectList"), never, ctx);
    expect(res).toMatchObject({ ok: true, result: [{ name: "core", path: CORE }] });
    // The policy frame the device already sends carries this summary.
    expect(policySummary(store.current(), summaryFacts(ex, ctx))).toEqual({
      mode: "sandbox",
      allowedDomains: [],
      projects: [{ name: "core", path: CORE }],
    });
  });

  it("refuses a path outside the workspace in sandbox mode", async () => {
    const ex = new FakeExecutor();
    const { res } = await serveOp(ex, r("projectAdd", { path: "/etc/core" }), never, {
      policy: store,
    });
    expect(res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("outside the device's workspace") },
    });
    // The refusal reached no file system call and changed nothing.
    expect(store.current().projects).toEqual([{ name: "core", path: CORE }]);
  });

  it("adds a directory inside the workspace, and a second add of the name is refused", async () => {
    const ex = new FakeExecutor();
    ex.stat = async (p) => (p === join(ROOTS.workspace, "proj") ? { size: 0, isDir: true } : null);
    const first = await serveOp(ex, r("projectAdd", { path: "proj" }), never, { policy: store });
    expect(first.res).toMatchObject({
      ok: true,
      result: { project: { name: "proj", path: join(ROOTS.workspace, "proj") } },
    });
    expect(first.detail).toBe(`project add proj ${join(ROOTS.workspace, "proj")}`);
    expect(readPolicy(dir).projects).toEqual([
      { name: "core", path: CORE },
      { name: "proj", path: join(ROOTS.workspace, "proj") },
    ]);
    const again = await serveOp(ex, r("projectAdd", { path: "proj" }), never, { policy: store });
    expect(again.res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("proj") },
    });
    expect(readPolicy(dir).projects).toHaveLength(2);
  });

  it("resolves a relative path against the owner's home in auto mode", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    store = new PolicyStore(dir);
    const ex = new FakeExecutor();
    const project = join(home, "code");
    ex.stat = async (p) => (p === project ? { size: 0, isDir: true } : null);
    const { res } = await serveOp(ex, r("projectAdd", { path: "code" }), never, {
      policy: store,
      home,
    });
    expect(res).toMatchObject({ ok: true, result: { project: { name: "code", path: project } } });
  });

  it("lists only what the current mode can read; the policy file keeps the rest", async () => {
    const outside = join(home, "code", "core");
    writePolicy(dir, {
      ...DEFAULT_POLICY,
      mode: "auto",
      projects: [
        { name: "core", path: CORE },
        { name: "home-core", path: outside },
      ],
    });
    store = new PolicyStore(dir);
    const ex = new FakeExecutor();
    const ctx = { policy: store, home, seen: {} as SeenState };
    const all = [
      { name: "core", path: CORE },
      { name: "home-core", path: outside },
    ];
    expect((await serveOp(ex, r("projectList"), never, ctx)).res).toMatchObject({ result: all });
    // The kernel's ceiling drops to sandbox: the project outside the workspace is no longer offered.
    ctx.seen.limits = { mode: "sandbox" };
    const inside = [{ name: "core", path: CORE }];
    expect((await serveOp(ex, r("projectList"), never, ctx)).res).toMatchObject({
      result: inside,
    });
    expect(policySummary(store.current(), summaryFacts(ex, ctx)).projects).toEqual(inside);
    expect(readPolicy(dir).projects).toEqual(all);
  });

  it("refuses a missing path, one that is not a directory, and one it cannot read", async () => {
    const ex = new FakeExecutor();
    ex.stat = async (p) => {
      if (p === join(ROOTS.workspace, "file")) return { size: 10, isDir: false };
      if (p === join(ROOTS.workspace, "locked")) throw new Error("EACCES: permission denied");
      return null;
    };
    const missing = await serveOp(ex, r("projectAdd", { path: "missing" }), never, {
      policy: store,
    });
    expect(missing.res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("does not exist") },
    });
    const file = await serveOp(ex, r("projectAdd", { path: "file" }), never, { policy: store });
    expect(file.res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("not a directory") },
    });
    const locked = await serveOp(ex, r("projectAdd", { path: "locked" }), never, { policy: store });
    expect(locked.res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("cannot be read") },
    });
    expect(readPolicy(dir).projects).toHaveLength(1);
  });

  it("removes a project by name; an unknown name changes nothing", async () => {
    const ex = new FakeExecutor();
    expect(
      (await serveOp(ex, r("projectRemove", { name: "nope" }), never, { policy: store })).res,
    ).toMatchObject({ ok: true, result: null });
    expect(readPolicy(dir).projects).toEqual([{ name: "core", path: CORE }]);
    const removed = await serveOp(ex, r("projectRemove", { name: "core" }), never, {
      policy: store,
    });
    expect(removed.res).toMatchObject({ ok: true, result: null });
    expect(removed.detail).toBe("project remove core");
    expect(readPolicy(dir).projects).toEqual([]);
  });

  it("suggests candidates under the mode's base, two levels down", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    store = new PolicyStore(dir);
    mkdirSync(join(home, "alpha", ".git"), { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "");
    mkdirSync(join(home, "x", "y", ".git"), { recursive: true });
    mkdirSync(join(home, "plain"), { recursive: true });
    const { res } = await serveOp(new FakeExecutor(), r("projectCandidates"), never, {
      policy: store,
      home,
    });
    expect(res).toMatchObject({
      ok: true,
      result: [
        { name: "alpha", path: join(home, "alpha") },
        { name: "y", path: join(home, "x", "y") },
      ],
    });
  });

  it("suggests nothing on a container device: its workspace is not visible to this process", async () => {
    const ex = Object.assign(new FakeExecutor(), {
      mode: "docker" as const,
      roots: { workspace: "/workspace", skills: "/skills", tmp: "/tmp" },
    });
    const { res } = await serveOp(ex, r("projectCandidates"), never, { policy: store, home });
    expect(res).toMatchObject({ ok: true, result: [] });
  });

  it("answers unsupported when the device has no policy store", async () => {
    const res = await serveOp(new FakeExecutor(), r("projectList"), never);
    expect(res.res).toMatchObject({
      ok: false,
      error: { kind: "error", message: "unsupported operation" },
    });
  });

  it("refuses a policy file whose projects field is malformed", () => {
    writeFileSync(
      policyPath(dir),
      `${JSON.stringify({ mode: "auto", projects: [{ name: "", path: "/w" }] })}\n`,
    );
    expect(() => new PolicyStore(dir)).toThrow(/projects/);
  });
});

/**
 * The project operations on the real {@link SwitchingExecutor}: the existence check follows the
 * scope's mode, not the file operations' window after the latest command.
 */
describe("project operations on the switching executor", () => {
  let dir: string;
  let home: string;
  let policy: Policy;
  let ex: SwitchingExecutor;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-projects-switch-"));
    home = mkdtempSync(join(tmpdir(), "device-projects-switch-home-"));
    // The sandboxed helper refuses anything outside the roots, like the real one.
    const sandboxed = new FakeExecutor();
    sandboxed.stat = async (p) => {
      if (p !== ROOTS.workspace && !p.startsWith(`${ROOTS.workspace}/`)) {
        throw new DeviceOpError("policy", `${p} is outside the device's roots`);
      }
      return { size: 0, isDir: true };
    };
    // The host reads with the owner's rights.
    const host = new FakeExecutor();
    host.stat = async (p) => (p.startsWith(`${home}/`) ? { size: 0, isDir: true } : null);
    ex = new SwitchingExecutor(sandboxed, host, () => policy);
  });
  afterEach(() => {
    ex.dispose();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const storeWith = (mode: Policy["mode"]): PolicyStore => {
    policy = { ...DEFAULT_POLICY, mode };
    writePolicy(dir, policy);
    return new PolicyStore(dir);
  };

  it("adds a project outside the workspace in auto mode before any command ran", async () => {
    const store = storeWith("auto");
    const path = join(home, "code", "core");
    const { res } = await serveOp(ex, r("projectAdd", { path: "code/core" }), never, {
      policy: store,
      home,
      seen: {},
    });
    expect(res).toMatchObject({ ok: true, result: { project: { name: "core", path } } });
    expect(readPolicy(dir).projects).toEqual([{ name: "core", path }]);
  });

  it("still refuses a project outside the workspace in sandbox scope", async () => {
    const path = join(home, "code", "core");
    // The machine's own sandbox mode.
    const sandboxStore = storeWith("sandbox");
    const own = await serveOp(ex, r("projectAdd", { path }), never, {
      policy: sandboxStore,
      home,
    });
    expect(own.res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("outside the device's workspace") },
    });
    // Auto on the machine, but the kernel's ceiling is sandbox.
    const autoStore = storeWith("auto");
    const capped = await serveOp(ex, r("projectAdd", { path }), never, {
      policy: autoStore,
      home,
      seen: { limits: { mode: "sandbox" } },
    });
    expect(capped.res).toMatchObject({
      ok: true,
      result: { refused: expect.stringContaining("outside the device's workspace") },
    });
    expect(readPolicy(dir).projects).toEqual([]);
  });

  it("reads through the sandboxed helper when the policy says sandbox, whatever the mode asked", async () => {
    policy = { ...DEFAULT_POLICY, mode: "sandbox" };
    await expect(ex.statAs("auto", join(home, "x"))).rejects.toMatchObject({ kind: "policy" });
    policy = { ...DEFAULT_POLICY, mode: "auto" };
    await expect(ex.statAs("sandbox", join(home, "x"))).rejects.toMatchObject({ kind: "policy" });
    expect(await ex.statAs("auto", join(home, "x"))).toEqual({ size: 0, isDir: true });
  });
});
