import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  containerCeiling,
  createDockerOperationBackend,
  hostPathOf,
} from "../src/exec/docker-operations.js";
import {
  checkLinuxRestrictedGrant,
  createHostOperationBackend,
} from "../src/exec/linux-operation-backend.js";
import type { LinuxProbe } from "../src/exec/linux-runtime.js";
import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const signal = new AbortController().signal;
const SUPPORTED: LinuxProbe = {
  restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
};

async function setup(
  platform: NodeJS.Platform,
  probe: LinuxProbe,
  extra: { runtimeHash?: string | undefined; restrictedSupported?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "cap-linux-select-"));
  dirs.push(dir);
  const roots = { workspace: join(dir, "w"), skills: join(dir, "s"), tmp: join(dir, "t") };
  const ceiling: DeviceOwnerCeiling = {
    revision: "one",
    outsideSandbox: true,
    network: "allowlist",
    roots,
    restrictedProjectReach: "workspace",
    allowedDomains: [],
    restrictedDeniedReadRoots: [],
    preparation: {
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    },
  };
  const launched: MacWorkerRequest[] = [];
  const startWorker = async (request: MacWorkerRequest) => {
    await request.beforeLaunch();
    await request.onLaunch({ pid: 1234, token: "t" });
    launched.push(request);
    return {
      ready: Promise.resolve(),
      completion: Promise.resolve({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      }),
      cancel: async () => {},
    };
  };
  const backend = await createHostOperationBackend(
    {
      deviceId: "d",
      instanceGeneration: "g",
      stateDir: dir,
      roots,
      pythonPath: "/usr/bin/python3",
      ...("runtimeHash" in extra
        ? extra.runtimeHash
          ? { runtimeHash: extra.runtimeHash }
          : {}
        : { runtimeHash: "hash" }),
      readOwnerCeiling: async () => ceiling,
    },
    {
      platform,
      linux: {
        probe: async () => probe,
        startWorker,
        ...(extra.restrictedSupported === false ? { restrictedSupported: false } : {}),
      },
    },
  );
  const scope = (full: boolean) => ({
    operationId: `op-${Math.random()}`,
    admitBeforeMs: Date.now() + 60_000,
    deviceId: "d",
    rootConversationId: "r",
    profileRevision: 0,
    ceilingRevision: "c",
    profile: full ? ("full-access" as const) : ("approve-for-me" as const),
    actor: { accountId: "a", conversationId: "r" },
    tag: "t",
    filesystem: full
      ? { kind: "device" as const }
      : { kind: "scoped" as const, readRoots: [], writeRoots: [roots.workspace] },
    network: full ? { kind: "environment" as const } : { kind: "none" as const },
  });
  const exec = async (full: boolean) => {
    const s = scope(full);
    const op = await backend
      .forExecution({ operationId: s.operationId, orgNetwork: { kind: "open-public", hosts: [] } })
      .operation({ id: "d" }, s, signal);
    return op.exec({ command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal });
  };
  return { backend, exec, launched };
}

describe("local operation backend selection", () => {
  it("Linux hosts get the Linux backend: restricted support is the probe's", async () => {
    const { backend, exec, launched } = await setup("linux", SUPPORTED);
    const support = await backend.permissionSupport({ id: "d" }, signal);
    expect(support).toEqual({
      version: 2,
      restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
      boundary: "operation",
      network: { openPublic: false, allowlist: true, perOperationHosts: true },
      outsideSandbox: true,
      background: true,
    });
    await expect(exec(false)).resolves.toMatchObject({ exitCode: 0 });
    expect(launched[0]?.grant.full).toBe(false);
  });

  it("an unsupported kernel fails closed for restricted work while Full keeps working", async () => {
    const { backend, exec, launched } = await setup("linux", {
      restricted: null,
      reason: "Landlock ABI 4 is below the required 6",
    });
    const support = await backend.permissionSupport({ id: "d" }, signal);
    expect(support.restricted).toBeNull();
    expect(support.unavailableReason).toMatch(/Landlock ABI 4/);
    expect(support.outsideSandbox).toBe(true);
    await expect(exec(false)).rejects.toMatchObject({ name: "SandboxPermissionUnsupportedError" });
    expect(launched).toEqual([]);
    await expect(exec(true)).resolves.toMatchObject({ exitCode: 0 });
    expect(launched.map((r) => r.grant.full)).toEqual([true]);
  });

  it("restricted needs an attested runtime binding and can be switched off, never on", async () => {
    const unbound = await setup("linux", SUPPORTED, { runtimeHash: undefined });
    expect(
      (await unbound.backend.permissionSupport({ id: "d" }, signal)).unavailableReason,
    ).toMatch(/attested runtime/);
    await expect(unbound.exec(false)).rejects.toMatchObject({
      name: "SandboxPermissionUnsupportedError",
    });
    const off = await setup("linux", SUPPORTED, { restrictedSupported: false });
    expect((await off.backend.permissionSupport({ id: "d" }, signal)).restricted).toBeNull();
  });

  it("macOS keeps its backend", async () => {
    const { backend } = await setup("darwin", SUPPORTED);
    const support = await backend.permissionSupport({ id: "d" }, signal);
    // the macOS backend decides restricted support itself (W3-M); the Linux probe is not asked
    expect(support.restricted).toBeNull();
    expect(support.unavailableReason).toMatch(/macOS/);
  });
});

describe("Linux restricted grant checks", () => {
  const grant = {
    full: false,
    readRoots: ["/home/u"],
    writeRoots: ["/home/u/project"],
    hosts: [],
    deniedReadRoots: ["/home/u/.ssh"],
    revision: "r",
  };
  it("refuses an exec grant whose root contains an owner-denied path", () => {
    expect(() => checkLinuxRestrictedGrant(grant, "exec")).toThrow(/owner denies/);
    // the refusal names the root and the denied path and says what to do instead
    expect(() => checkLinuxRestrictedGrant(grant, "exec")).toThrow(
      /\/home\/u .*\/home\/u\/\.ssh.*narrower directory.*Full access/,
    );
    expect(() =>
      checkLinuxRestrictedGrant({ ...grant, readRoots: ["/home/u/project"] }, "exec"),
    ).not.toThrow();
  });
  it("leaves native grants to the agent's per-path check", () => {
    expect(() => checkLinuxRestrictedGrant(grant, "native")).not.toThrow();
  });
});

describe("local-Docker operation backend paths", () => {
  const hostRoots = { workspace: "/h/w", skills: "/h/s", tmp: "/h/t" };
  it("maps the owner's ceiling to the container's mounted roots", () => {
    const mapped = containerCeiling({
      revision: "one",
      outsideSandbox: false,
      network: "allowlist",
      roots: hostRoots,
      restrictedProjectReach: "workspace",
      allowedDomains: ["a.example"],
      restrictedDeniedReadRoots: ["/home/u/.ssh"],
      preparation: { skillsRoot: "/h/s", attachmentsBase: "/h/w/attachments" },
    });
    expect(mapped).toMatchObject({
      revision: "one",
      outsideSandbox: false,
      network: "allowlist",
      roots: { workspace: "/workspace", skills: "/skills", tmp: "/tmp" },
      allowedDomains: ["a.example"],
      restrictedDeniedReadRoots: [],
      preparation: { skillsRoot: "/skills", attachmentsBase: "/workspace/attachments" },
    });
  });
  it("maps mounted container paths to the host directories behind them, nothing else", () => {
    expect(hostPathOf("/workspace/a/b", hostRoots)).toBe("/h/w/a/b");
    expect(hostPathOf("/tmp", hostRoots)).toBe("/h/t");
    expect(hostPathOf("/workspacex", hostRoots)).toBeUndefined();
    expect(hostPathOf("/etc/passwd", hostRoots)).toBeUndefined();
  });
  it("writes background artifacts behind the mounts and refuses targets outside them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-docker-ops-"));
    dirs.push(dir);
    const launched: MacWorkerRequest[] = [];
    const backend = await createDockerOperationBackend(
      {
        deviceId: "d",
        instanceGeneration: "g",
        stateDir: dir,
        pythonPath: "/usr/bin/python3",
        runtimeHash: "hash",
        hostRoots,
        readOwnerCeiling: async () => ({
          revision: "one",
          outsideSandbox: true,
          network: "allowlist",
          roots: hostRoots,
          restrictedProjectReach: "workspace",
          allowedDomains: [],
          restrictedDeniedReadRoots: [],
          preparation: { skillsRoot: "/h/s", attachmentsBase: "/h/w/attachments" },
        }),
        container: {
          operationContainer: async () => {
            throw new Error("no container in this test");
          },
        },
      },
      {
        probe: async () => SUPPORTED,
        startWorker: async (request) => {
          launched.push(request);
          throw new Error("stop before launch");
        },
      },
    );
    const start = (outputPath: string) => {
      const operationId = `op-${Math.random()}`;
      return backend
        .forExecution({ operationId, orgNetwork: { kind: "open-public", hosts: [] } })
        .background.start(
          { id: "d" },
          {
            operationId,
            admitBeforeMs: Date.now() + 60_000,
            deviceId: "d",
            rootConversationId: "r",
            profileRevision: 0,
            ceilingRevision: "c",
            profile: "full-access",
            actor: { accountId: "a", conversationId: "r" },
            tag: "t",
            filesystem: { kind: "device" },
            network: { kind: "environment" },
          },
          {
            command: "true",
            timeoutMs: 1000,
            maxOutputBytes: 10,
            taskId: "task",
            outputPath,
            retainUntilMs: Date.now() + 60_000,
            signal,
          },
        );
    };
    await expect(start("/etc/out.log")).rejects.toMatchObject({
      name: "SandboxScopeDeniedError",
    });
    expect(launched).toEqual([]);
  });
});
