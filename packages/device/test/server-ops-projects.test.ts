import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyStore } from "../src/policy-store.js";
import { policySummary, serveOp, summaryFacts } from "../src/server-ops.js";
import { DEFAULT_POLICY, policyPath, readPolicy, writePolicy } from "../src/state.js";
import { FakeExecutor, ROOTS } from "./fake-kernel.js";

const never = new AbortController().signal;

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
      projects: [{ name: "core", path: "/w/core" }],
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
    expect(res).toMatchObject({ ok: true, result: [{ name: "core", path: "/w/core" }] });
    // The policy frame the device already sends carries this summary.
    expect(policySummary(store.current(), summaryFacts(ex, ctx))).toEqual({
      mode: "sandbox",
      allowedDomains: [],
      projects: [{ name: "core", path: "/w/core" }],
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
    expect(store.current().projects).toEqual([{ name: "core", path: "/w/core" }]);
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
      { name: "core", path: "/w/core" },
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
    expect(readPolicy(dir).projects).toEqual([{ name: "core", path: "/w/core" }]);
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
