import { spawn } from "node:child_process";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNativeHelper } from "../src/exec/native-helper-client.js";
import { stageRuntimeSource } from "../src/exec/runtime-source.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// restricted workers launch only from a verified, sealed runtime closure (B-7)
const workspace = { runtimeHash: "", cleanup: async () => {} };
beforeAll(async () => {
  Object.assign(workspace, await sealWorkspaceRuntime());
});
afterAll(async () => {
  await workspace.cleanup();
});

describe("private pinned descriptor helper transport", () => {
  it("handshakes inherited descriptors before dispatch and preserves ordinary file semantics", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-native-")));
    const fd = await open(dir, "r");
    try {
      const helper = await stageRuntimeSource(dir);
      await writeFile(join(dir, "hello"), "hello");
      let ready = false;
      const result = await runNativeHelper(
        { method: "readFile", path: join(dir, "hello"), maxBytes: 3 },
        [{ path: dir, fd: fd.fd, access: "read" }],
        {
          pythonPath: "/usr/bin/python3",
          helperPath: helper,
          spawn: (command, args, opts) => spawn(command, args, opts),
          beforeDispatch: async () => {
            ready = true;
          },
        },
        new AbortController().signal,
      );
      expect(ready).toBe(true);
      expect(result).toEqual({ dataB64: Buffer.from("hel").toString("base64"), truncated: true });
      expect((await fd.stat()).isDirectory()).toBe(true);
    } finally {
      await fd.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects missing inherited descriptors without reopening a path", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-native-")));
    const fd = await open(dir, "r");
    try {
      const helper = await stageRuntimeSource(dir);
      await expect(
        runNativeHelper(
          { method: "stat", path: dir },
          [{ path: dir, fd: fd.fd, access: "read" }],
          {
            pythonPath: "/usr/bin/python3",
            helperPath: helper,
            spawn: (command, args, opts) =>
              spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe", "pipe"] }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/descriptor|handshake/);
    } finally {
      await fd.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it.runIf(process.platform === "darwin")(
  "production macOS wrapper inherits pinned descriptors and reads an ordinary owned fixture",
  async () => {
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const { mkdir } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-native-")));
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    await writeFile(join(project, "hello"), "hello");
    const scope = {
      operationId: "native-owned",
      admitBeforeMs: Date.now() + 30000,
      deviceId: "owned-fixture",
      rootConversationId: "r",
      profileRevision: 0,
      ceilingRevision: "fixture",
      profile: "approve-for-me" as const,
      actor: { accountId: "a", conversationId: "r" },
      tag: "native-owned",
      filesystem: { kind: "scoped" as const, readRoots: [project], writeRoots: [] },
      network: { kind: "none" as const },
    };
    const workers = [];
    try {
      const worker = await startMacOperationWorker(
        {
          kind: "native",
          scope,
          purpose: "operation",
          native: { method: "readFile", path: join(project, "hello"), maxBytes: 100 },
          grant: {
            full: false,
            readRoots: [project],
            writeRoots: [],
            hosts: [],
            deniedReadRoots: [stateDir],
            revision: "fixture",
          },
          stateDir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          beforeLaunch: async () => {},
          onLaunch: async () => {},
        },
        AbortSignal.timeout(15000),
      );
      workers.push(worker);
      await worker.ready;
      expect(await worker.completion).toEqual({
        dataB64: Buffer.from("hello").toString("base64"),
        truncated: false,
      });
    } finally {
      await Promise.all(workers.map((w) => w.cancel("fixture cleanup")));
      await rm(root, { recursive: true, force: true });
    }
  },
);

// One test per method: each case launches five fresh native workers, and running all methods in a
// single test brushed against the default timeout under parallel load.
it
  .runIf(process.platform === "darwin")
  .each(["readFile", "writeFile", "stat", "list", "scan"] as const)(
  "fresh macOS native workers enforce %s and preserve Full controls",
  async (method) => {
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const { mkdir, symlink } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-methods-")));
    const stateDir = join(root, "state");
    const project = join(root, "project");
    const sibling = join(root, "sibling");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    await mkdir(sibling);
    for (const d of [project, sibling]) {
      await writeFile(join(d, "file"), "owned");
      await writeFile(join(d, "AGENTS.md"), "owned");
    }
    await symlink(sibling, join(project, "escape"));
    const workers: import("../src/exec/operation-worker.js").MacWorkerHandle[] = [];
    const run = async (
      method: "readFile" | "writeFile" | "stat" | "list" | "scan",
      path: string,
      full = false,
    ) => {
      const scope = {
        operationId: `native-${workers.length}`,
        admitBeforeMs: Date.now() + 30000,
        deviceId: "fixture",
        rootConversationId: "r",
        profileRevision: 0,
        ceilingRevision: "fixture",
        profile: "approve-for-me" as const,
        actor: { accountId: "a", conversationId: "r" },
        tag: "fixture",
        filesystem: { kind: "scoped" as const, readRoots: [project], writeRoots: [project] },
        network: { kind: "none" as const },
      };
      const worker = await startMacOperationWorker(
        {
          kind: "native",
          scope,
          purpose: "operation",
          native: {
            method,
            path,
            maxBytes: 100,
            limit: 10,
            dataB64: Buffer.from("written").toString("base64"),
          },
          grant: {
            full,
            readRoots: full ? ["/"] : [project],
            writeRoots: full ? ["/"] : [project],
            hosts: [],
            deniedReadRoots: full ? [] : [stateDir],
            revision: "fixture",
          },
          stateDir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          beforeLaunch: async () => {},
          onLaunch: async () => {},
        },
        AbortSignal.timeout(15000),
      );
      workers.push(worker);
      await worker.ready;
      return worker.completion;
    };
    try {
      const suffix = method === "list" || method === "scan" ? "" : "/file";
      expect(await run(method, project + suffix)).toBeDefined();
      await expect(run(method, sibling + suffix)).rejects.toThrow();
      await expect(run(method, join(project, "escape") + suffix)).rejects.toThrow();
      expect(await run(method, sibling + suffix, true)).toBeDefined();
      await expect(run(method, sibling + suffix)).rejects.toThrow();
    } finally {
      await Promise.all(workers.map((w) => w.cancel("owned fixture cleanup")));
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "darwin")(
  "canonical macOS tmp aliases retain the same pinned native root",
  async () => {
    const { mkdir } = await import("node:fs/promises");
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const root = await mkdtemp("/tmp/cap-native-alias-");
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    await writeFile(join(project, "hello"), "hello");
    let worker: import("../src/exec/operation-worker.js").MacWorkerHandle | undefined;
    try {
      worker = await startMacOperationWorker(
        {
          kind: "native",
          scope: {
            operationId: "alias",
            admitBeforeMs: Date.now() + 30000,
            deviceId: "d",
            accountId: "a",
            ceilingRevision: "r",
            readRoots: [project],
            tag: "alias",
          },
          purpose: "browse",
          native: { method: "stat", path: join(project, "hello") },
          grant: {
            full: false,
            readRoots: [project],
            writeRoots: [],
            hosts: [],
            deniedReadRoots: [stateDir],
            revision: "fixture",
          },
          stateDir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          beforeLaunch: async () => {},
          onLaunch: async () => {},
        },
        AbortSignal.timeout(15000),
      );
      await worker.ready;
      expect(await worker.completion).toEqual({ size: 5, isDir: false });
    } finally {
      await worker?.cancel("fixture cleanup");
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("rejects malformed JSON and bounded output overflow from trusted transport failures", async () => {
  for (const mode of ["json", "overflow"]) {
    await expect(
      runNativeHelper(
        { method: "stat", path: "/owned" },
        [],
        {
          pythonPath: "/usr/bin/python3",
          helperPath: "/fixed-unused-in-test",
          spawn: (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                "-e",
                `require('node:fs').writeSync(3,'ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.stdout.end(${mode === "json" ? "'invalid-json'" : "'x'.repeat(2*1024*1024)"}));`,
              ],
              options,
            ),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(mode === "json" ? /invalid bounded JSON/ : /bounded transport/);
  }
});

it("establishes only a narrow descriptor root and refuses sibling data and symlink components", async () => {
  const { mkdir, readFile, stat, symlink } = await import("node:fs/promises");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-anchor-")));
  const fd = await open(dir, "r");
  try {
    const helperPath = await stageRuntimeSource(dir);
    const path = join(dir, "attachments", "123456789abc");
    const roots = [
      { path, fd: fd.fd, access: "write" as const, components: ["attachments", "123456789abc"] },
    ];
    const invoke = (request: import("../src/exec/native-helper-client.js").NativeHelperRequest) =>
      runNativeHelper(
        request,
        roots,
        { pythonPath: "/usr/bin/python3", helperPath },
        new AbortController().signal,
      );
    expect(await invoke({ method: "stat", path })).toBeNull();
    await expect(stat(join(dir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(dir, "sibling"), "unchanged");
    await expect(
      invoke({ method: "readFile", path: join(dir, "sibling"), maxBytes: 20 }),
    ).rejects.toThrow(/scope|Native/);
    await expect(
      invoke({ method: "writeFile", path: join(dir, "sibling"), dataB64: "eA==" }),
    ).rejects.toThrow(/scope|Native/);
    await expect(stat(join(dir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
    await invoke({ method: "writeFile", path: join(path, "marker"), dataB64: "b2s=" });
    expect(await readFile(join(path, "marker"), "utf8")).toBe("ok");
    expect(await readFile(join(dir, "sibling"), "utf8")).toBe("unchanged");
    const target = join(dir, "target");
    await mkdir(target);
    await symlink(target, join(dir, "linked"));
    await expect(
      runNativeHelper(
        { method: "writeFile", path: join(dir, "linked", "child", "marker"), dataB64: "eA==" },
        [
          {
            path: join(dir, "linked", "child"),
            fd: fd.fd,
            access: "write",
            components: ["linked", "child"],
          },
        ],
        { pythonPath: "/usr/bin/python3", helperPath },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Native/);
    await expect(stat(join(target, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fd.stat()).isDirectory()).toBe(true);
  } finally {
    await fd.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.runIf(process.platform === "darwin")(
  "missing-root macOS establishment keeps Git and sibling writes denied inside the fixed helper",
  async () => {
    const { mkdir, readFile, stat } = await import("node:fs/promises");
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-establish-policy-")));
    const stateDir = join(dir, "state");
    await mkdir(stateDir, { mode: 0o700 });
    const conversation = join(dir, "attachments", "123456789abc");
    const sibling = join(dir, "sibling");
    await writeFile(sibling, "unchanged");
    const workers: import("../src/exec/operation-worker.js").MacWorkerHandle[] = [];
    const run = async (path: string) => {
      const worker = await startMacOperationWorker(
        {
          kind: "native",
          purpose: "preparation",
          scope: {
            operationId: `establish-${workers.length}`,
            deviceId: "d",
            purpose: "attachments",
            writeRoots: [conversation],
            tag: "fixture",
          },
          native: { method: "writeFile", path, dataB64: "eA==" },
          grant: {
            full: false,
            readRoots: [],
            writeRoots: [conversation],
            hosts: [],
            deniedReadRoots: [stateDir],
            revision: "fixture",
          },
          stateDir,
          pythonPath: "/usr/bin/python3",
          runtimeHash: workspace.runtimeHash,
          beforeLaunch: async () => {},
          onLaunch: async () => {},
        },
        AbortSignal.timeout(15000),
      );
      workers.push(worker);
      await worker.ready;
      return worker.completion;
    };
    try {
      await expect(run(sibling)).rejects.toThrow(/Native/);
      await expect(stat(join(dir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(run(join(conversation, ".git", "config"))).rejects.toThrow(/Native/);
      await expect(stat(join(conversation, ".git", "config"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(sibling, "utf8")).toBe("unchanged");
      await run(join(conversation, "marker"));
      expect(await readFile(join(conversation, "marker"), "utf8")).toBe("x");
    } finally {
      await Promise.all(workers.map((w) => w.cancel("owned fixture cleanup")));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
