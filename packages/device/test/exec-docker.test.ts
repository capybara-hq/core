import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CONTAINER_FORMAT,
  CONTAINER_FORMAT_LABEL,
  containerName,
  containerSpec,
  containerUser,
  DockerContainer,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_TAG,
} from "../src/exec/docker.js";
import { createDockerOperationBackend } from "../src/exec/docker-operations.js";
import { osRoots, prepareDeviceDir } from "../src/exec/shared.js";
import { DEFAULT_POLICY, FULL_OWNER_CEILING } from "../src/state.js";

/** The policy these tests were written against: the owner allows Full access. */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls `cond` until it holds; the test's own timeout bounds the wait. */
const until = async (cond: () => boolean): Promise<void> => {
  while (!cond()) await sleep(50);
};

describe("docker container constants", () => {
  it("pins the published sandbox image tag", () => {
    expect(SANDBOX_IMAGE_TAG).toBe("0.1.0-rc.5");
    expect(SANDBOX_IMAGE).toBe("ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.5");
    expect(containerName("env_1")).toBe("capybara-device-env_1");
  });
});

describe.skipIf(!hasDocker)("DockerContainer", () => {
  let base: string;
  let dir: string;
  let envId: string;
  let ex: DockerContainer;
  const live = new AbortController().signal;

  /** Holds the container for one operation and gives it back: it exists and runs afterwards. */
  const hold = async (c: DockerContainer = ex) => {
    const held = await c.operationContainer(live);
    held.release();
    return held;
  };
  /** Runs a shell command in the container as its user (what an operation's agent does). */
  const inContainer = (command: string): string =>
    execFileSync(
      "docker",
      ["exec", "-u", containerUser(), containerName(envId), "/bin/sh", "-c", command],
      { encoding: "utf8" },
    );
  const inspect = (f: string) =>
    execFileSync("docker", ["inspect", "-f", f, containerName(envId)], {
      encoding: "utf8",
    }).trim();

  beforeAll(() => {
    const have = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" });
    if (have.status !== 0) execFileSync("docker", ["pull", SANDBOX_IMAGE], { stdio: "ignore" });
  }, 300_000);

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "device-docker-")));
    dir = join(base, "env");
    prepareDeviceDir(dir);
    envId = `t${randomBytes(6).toString("hex")}`;
    ex = new DockerContainer({ dir, deviceId: envId, policy: () => FULL_POLICY });
  });

  afterEach(() => {
    spawnSync("docker", ["rm", "-f", containerName(envId)], { stdio: "ignore" });
    rmSync(base, { recursive: true, force: true });
  });

  it("mounts the device directory's roots; files land in the device dir; skills are read only", async () => {
    const held = await hold();
    expect(held.name).toBe(containerName(envId));
    expect(held.user).toBe(containerUser());
    const out = inContainer("pwd; id -u; echo hi > /workspace/made.txt; echo t > /tmp/x");
    // the host user on Linux, the image's sandbox user (1000) elsewhere
    const uid = containerUser().split(":")[0];
    expect(out.split("\n").slice(0, 2)).toEqual(["/workspace", uid]);
    expect(readFileSync(join(dir, "workspace", "made.txt"), "utf8")).toBe("hi\n");
    expect(readFileSync(join(dir, "tmp", "x"), "utf8")).toBe("t\n");
    expect(ex.roots).toEqual({ workspace: "/workspace", skills: "/skills", tmp: "/tmp" });
    expect(inContainer("touch /skills/a 2>&1; true")).toMatch(/Read-only/i);
  });

  it("hosts permission operations in its container from a root-owned staged runtime", async () => {
    const state = join(base, "state");
    mkdirSync(state, { mode: 0o700 });
    const hostRoots = osRoots(dir);
    const backend = await createDockerOperationBackend(
      {
        deviceId: envId,
        instanceGeneration: "g",
        stateDir: state,
        pythonPath: "/usr/bin/python3",
        runtimeHash: "h",
        hostRoots,
        readOwnerCeiling: async () => ({
          revision: "one",
          fullAccess: true,
          roots: hostRoots,
          restrictedProjectReach: "workspace",
          restrictedAllowedDomains: [],
          restrictedDeniedReadRoots: [],
          preparation: {
            skillsRoot: hostRoots.skills,
            attachmentsBase: join(hostRoots.workspace, "attachments"),
          },
          fullNetwork: "environment",
        }),
        container: ex,
      },
      { acquireRuntime: async () => ({ release: () => {} }) },
    );
    const support = await backend.permissionSupport({ id: envId }, live);
    expect(support).toMatchObject({ fullAccess: true, background: true });

    const scope = (full: boolean, n: number) => ({
      operationId: `op-${n}`,
      admitBeforeMs: Date.now() + 60_000,
      deviceId: envId,
      rootConversationId: "r",
      profileRevision: 0,
      ceilingRevision: "c",
      profile: full ? ("full-access" as const) : ("approve-for-me" as const),
      actor: { accountId: "a", conversationId: "r" },
      tag: `t${n}`,
      filesystem: full
        ? { kind: "device" as const }
        : { kind: "scoped" as const, readRoots: [], writeRoots: ["/workspace/proj"] },
      network: full ? { kind: "environment" as const } : { kind: "none" as const },
    });
    const authority = (operationId: string) => ({
      operationId,
      orgNetwork: { kind: "open-public" as const, hosts: [] },
    });
    const run = async (full: boolean, n: number, command: string) => {
      const s = scope(full, n);
      const op = await backend
        .forExecution(authority(s.operationId))
        .operation({ id: envId }, s, live);
      return op.exec({
        command,
        ...(full ? {} : { cwd: "/workspace/proj" }),
        timeoutMs: 20_000,
        maxOutputBytes: 4096,
        signal: live,
      });
    };
    // Full: the container user's own authority
    const full = await run(
      true,
      1,
      "mkdir -p /workspace/proj && echo full > /tmp/full.txt && cat /etc/hostname >/dev/null",
    );
    expect(full.exitCode).toBe(0);
    expect(readFileSync(join(dir, "tmp", "full.txt"), "utf8")).toBe("full\n");
    // a Full background artifact lands in the host directory behind the mount
    const fs = scope(true, 4);
    const fullBg = backend.forExecution(authority(fs.operationId)).background;
    const fullRef = await fullBg.start({ id: envId }, fs, {
      command: "echo full-background",
      cwd: "/workspace",
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
      taskId: "task-full",
      outputPath: "/workspace/proj/full.log",
      retainUntilMs: Date.now() + 60_000,
      signal: live,
    });
    for (;;) {
      const status = await fullBg.status({ id: envId }, fullRef, live);
      if (status.state !== "running") break;
      await sleep(50);
    }
    expect(readFileSync(join(dir, "workspace", "proj", "full.log"), "utf8")).toBe(
      "full-background\n",
    );
    // Docker Desktop's file sharing drops Landlock's inode rules on the bind mounts: the
    // self-check reports restricted unavailable there instead of denying every command
    if (support.restricted === null)
      expect(support.unavailableReason).toMatch(/Landlock rules do not hold|is unavailable/);
    else {
      // restricted: only its granted root, through the launcher
      const r = await run(false, 2, "echo r > inside.txt; echo pwn > /tmp/outside.txt; true");
      expect(r.exitCode).toBe(0);
      expect(readFileSync(join(dir, "workspace", "proj", "inside.txt"), "utf8")).toBe("r\n");
      expect(existsSync(join(dir, "tmp", "outside.txt"))).toBe(false);
      // a background artifact lands in the host directory behind the mount
      const s = scope(false, 3);
      const bg = backend.forExecution(authority(s.operationId)).background;
      const ref = await bg.start({ id: envId }, s, {
        command: "echo background",
        cwd: "/workspace/proj",
        timeoutMs: 20_000,
        maxOutputBytes: 4096,
        taskId: "task",
        outputPath: "/workspace/proj/out.log",
        retainUntilMs: Date.now() + 60_000,
        signal: live,
      });
      await until(() => existsSync(join(dir, "workspace", "proj", "out.log")));
      for (;;) {
        const status = await bg.status({ id: envId }, ref, live);
        if (status.state !== "running") break;
        await sleep(50);
      }
      expect(readFileSync(join(dir, "workspace", "proj", "out.log"), "utf8")).toBe("background\n");
    }
  });

  it("reuses the container and recreates it when the mounts differ", async () => {
    await hold();
    const id1 = inspect("{{.Id}}");
    await hold(new DockerContainer({ dir, deviceId: envId, policy: () => FULL_POLICY }));
    expect(inspect("{{.Id}}")).toBe(id1);
    const other = join(base, "env2");
    mkdirSync(other);
    await hold(new DockerContainer({ dir: other, deviceId: envId, policy: () => FULL_POLICY }));
    inContainer("touch /workspace/here");
    expect(existsSync(join(other, "workspace", "here"))).toBe(true);
  });

  it("hardens the container and recreates one made with other flags", async () => {
    await hold();
    expect(inspect("{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PidsLimit}}")).toBe("true 1024");
    expect(inspect("{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}")).toBe(
      "[ALL] [no-new-privileges:true]",
    );
    expect(inContainer("touch /etc/x 2>&1; echo $?")).toMatch(/Read-only|denied/i);
    const id = inspect("{{.Id}}");
    spawnSync("docker", ["rm", "-f", containerName(envId)], { stdio: "ignore" });
    // An old container (other spec label) is replaced.
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      containerName(envId),
      "--label",
      "capybara.device.spec=old",
      "--entrypoint",
      "sleep",
      SANDBOX_IMAGE,
      "infinity",
    ]);
    await hold(new DockerContainer({ dir, deviceId: envId, policy: () => FULL_POLICY }));
    expect(inspect("{{.Config.Labels}}")).not.toContain("spec:old");
    expect(inspect("{{.HostConfig.ReadonlyRootfs}}")).toBe("true");
    expect(inspect("{{.Id}}")).not.toBe(id);
  });

  it("applies the policy's cpu and memory ceilings, swap equal to memory", async () => {
    await hold(
      new DockerContainer({
        dir,
        deviceId: envId,
        policy: () => ({ ...FULL_POLICY, cpu: 1.5, memoryMb: 256 }),
      }),
    );
    expect(
      inspect("{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}"),
    ).toBe(`1500000000 ${256 * 1024 * 1024} ${256 * 1024 * 1024}`);
  });

  it("recreates the container for a changed policy only once no operation holds it", async () => {
    let memoryMb: number | null = null;
    const c = new DockerContainer({
      dir,
      deviceId: envId,
      policy: () => ({ ...FULL_POLICY, memoryMb }),
    });
    const held = await c.operationContainer(live);
    const id = inspect("{{.Id}}");
    memoryMb = 256;
    // a second operation while the first holds it: the same container
    await hold(c);
    expect(inspect("{{.Id}}")).toBe(id);
    held.release();
    // idle now: the next operation gets a container with the new flags
    await hold(c);
    expect(inspect("{{.Id}}")).not.toBe(id);
    expect(inspect("{{.HostConfig.Memory}}")).toBe(String(256 * 1024 * 1024));
  });

  it("recreates a container found without the bridge, never reconnects it", async () => {
    await hold();
    const id = inspect("{{.Id}}");
    execFileSync("docker", ["network", "disconnect", "bridge", containerName(envId)]);
    const fresh = new DockerContainer({ dir, deviceId: envId, policy: () => FULL_POLICY });
    await hold(fresh);
    expect(inspect("{{.Id}}")).not.toBe(id);
    expect(inspect("{{json .NetworkSettings.Networks}}")).toContain('"bridge"');
  });

  it("recreates on first use a container a protocol 2 program made (no format version)", async () => {
    // exactly the flags and spec label the program wrote before the format version existed
    const flags = ex.runFlags();
    const at = flags.indexOf(`${CONTAINER_FORMAT_LABEL}=${CONTAINER_FORMAT}`);
    expect(flags[at - 1]).toBe("--label");
    const old = [...flags.slice(0, at - 1), ...flags.slice(at + 1)];
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      containerName(envId),
      "--label",
      `capybara.device.spec=${containerSpec(old)}`,
      ...old,
    ]);
    const id = inspect("{{.Id}}");
    await hold();
    expect(inspect("{{.Id}}")).not.toBe(id);
    expect(inspect(`{{index .Config.Labels "${CONTAINER_FORMAT_LABEL}"}}`)).toBe(
      String(CONTAINER_FORMAT),
    );
  });

  it("an abort while waiting holds nothing; an unreadable policy refuses the operation", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(ex.operationContainer(aborted.signal)).rejects.toThrow();
    const broken = new DockerContainer({
      dir,
      deviceId: envId,
      policy: () => {
        throw new Error("policy.json is not valid JSON");
      },
    });
    await expect(broken.operationContainer(live)).rejects.toThrow(/not valid JSON/);
  });

  it("a reused container whose mounts lost the directory is recreated", async () => {
    writeFileSync(join(dir, "workspace", "old"), "old");
    await hold();
    const first = inspect("{{.Id}}");
    // A new program over the same directory reuses the container while its mounts still match.
    await hold(new DockerContainer({ dir, deviceId: envId, policy: () => FULL_POLICY }));
    expect(inContainer("cat /workspace/old")).toBe("old");
    expect(inspect("{{.Id}}")).toBe(first);
    // The directory is lost and recreated by login: the container must see the new one.
    rmSync(dir, { recursive: true });
    prepareDeviceDir(dir);
    writeFileSync(join(dir, "workspace", "new"), "new");
    await hold(new DockerContainer({ dir, deviceId: envId, policy: () => FULL_POLICY }));
    expect(inContainer("cat /workspace/new; ls /workspace")).toBe("newnew\n");
    expect(readdirSync(join(dir, "workspace"))).toEqual(["new"]);
  });

  it("refuses to create the container once the device directory is gone", async () => {
    rmSync(dir, { recursive: true });
    await expect(ex.operationContainer(live)).rejects.toThrow(/device directory is gone/);
  });
});

describe("containerUser", () => {
  it("runs as the host user on Linux, never root, and as the image's user elsewhere", async () => {
    expect(containerUser("linux", 1001, 127)).toBe("1001:127");
    expect(containerUser("linux", 0, 0)).toBe("1000:1000");
    expect(containerUser("darwin", 501, 20)).toBe("1000:1000");
  });
});
