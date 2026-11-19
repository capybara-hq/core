import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The device's own test helpers (the device package may not depend on this one, so its backends
// meet the harness here): a hardened container with endpoints, and the bundled backend server.
import {
  dockerUnavailable,
  inspect,
  type LinuxDevice,
  NAMES,
  scopeFor,
  startLinuxDevice,
} from "../../device/test/linux-docker-fixture.js";
import {
  authorityFor,
  type HostBackend,
  HostServer,
  hostBackend,
  installServer,
  localServerFile,
} from "../../device/test/linux-host-fixture.js";
import type { NativeFixtureEntry } from "../src/sandbox-native-conformance.js";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionEndpoint,
  type SandboxPermissionFixture,
} from "../src/sandbox-permission-conformance.js";

const unavailable = dockerUnavailable();
const required = process.env.CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED === "1";

describe.runIf(required && unavailable !== null)("Linux restricted runtime is required", () => {
  it("has Docker and the sandbox image", () => {
    throw new Error(`CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${unavailable}`);
  });
});

/** The conformance fixture over a device backend whose operations run in the container. */
function fixture(device: LinuxDevice, backend: HostBackend): SandboxPermissionFixture {
  const id = randomUUID().slice(0, 8);
  const root = `/workspace/project-${id}`;
  const sibling = `/workspace/sibling-${id}`;
  device.run(`mkdir ${root} ${sibling} && printf rc > /home/sandbox/.profile-${id}`);
  const endpoint = (
    key: keyof typeof NAMES,
    address: string,
    port: number,
  ): SandboxPermissionEndpoint => ({
    name: NAMES[key],
    address,
    port,
    receipts: async () => {
      const value = (await inspect(device, {
        what: "read",
        path: `/opt/capybara-receipts/${key}`,
      })) as string | null;
      return value === null ? 0 : Number(Buffer.from(value, "base64").toString());
    },
  });
  const read = async (path: string) => {
    const value = (await inspect(device, { what: "read", path })) as string | null;
    return value === null ? null : new Uint8Array(Buffer.from(value, "base64"));
  };
  return {
    root,
    sibling,
    protectedPaths: [`/home/sandbox/.profile-${id}`],
    // a local device ties the environment network to Full access (owner ceiling policy)
    restrictedEnvironment: "refused",
    endpoints: {
      granted: endpoint("granted", "127.0.0.1", 18080),
      ungranted: [endpoint("ungranted4", "127.0.0.1", 18081), endpoint("ungranted6", "::1", 18082)],
      // allowlisted names are reached only through the operation's own proxy
      access: "proxy",
    },
    support: () => backend.support(),
    operation: async (grant) => {
      const scope = scopeFor(backend.deviceId, grant);
      return backend.operation(scope, authorityFor(scope.operationId));
    },
    seed: async (entries: readonly NativeFixtureEntry[]) => {
      await inspect(
        device,
        {
          what: "seed",
          entries: entries.map((entry) =>
            entry.kind === "file"
              ? { ...entry, data: undefined, dataB64: Buffer.from(entry.data).toString("base64") }
              : entry,
          ),
        },
        "1000:1000",
      );
    },
    inspect: {
      readFile: read,
      mode: async (path) => (await inspect(device, { what: "mode", path })) as number | null,
      alive: async (pids) => (await inspect(device, { what: "alive", pids })) as number[],
      outside: async (program, args) =>
        String(
          await inspect(device, { what: "outside", program, args }, "1000:1000").catch(
            (error: Error) => {
              throw new Error(`outside program failed: ${error.message}`);
            },
          ),
        ),
    },
    dispose: async () => {},
  };
}

// The capybara-device Linux operation backends against the full permission conformance in a
// hardened container (aarch64 locally; x86_64 on CI with CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1).
describe.skipIf(unavailable !== null)("capybara-device Linux operation backends", () => {
  let device: LinuxDevice;
  const servers: HostServer[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    device = await startLinuxDevice();
    await installServer(device);
  });
  afterAll(async () => {
    for (const server of servers) server.close();
    for (const cleanup of cleanups) await cleanup();
    device?.remove();
  });

  it("Linux host backend: passes the full permission conformance", async () => {
    device.run("mkdir -m 700 /home/sandbox/state-host");
    const server = new HostServer(device);
    servers.push(server);
    const backend = await hostBackend(server, { stateDir: "/home/sandbox/state-host" });
    const support = await backend.support();
    if (required) expect(support.restricted).not.toBeNull();
    await runSandboxPermissionConformance(fixture(device, backend));
  });

  it("local-Docker backend: passes the full permission conformance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-docker-backend-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const server = new HostServer(await localServerFile(dir));
    servers.push(server);
    const state = join(dir, "state");
    await import("node:fs/promises").then((fs) => fs.mkdir(state, { mode: 0o700 }));
    const backend = await hostBackend(server, {
      stateDir: state,
      deviceId: "device-docker",
      docker: {
        container: device.name,
        hostRoots: { workspace: join(dir, "w"), skills: join(dir, "s"), tmp: join(dir, "t") },
      },
    });
    const support = await backend.support();
    if (required) expect(support.restricted).not.toBeNull();
    await runSandboxPermissionConformance(fixture(device, backend));
    // every operation's agent shares the container's files lock, which no restricted grant reaches
    const lock = "/dev/shm/capybara-device-files.lock";
    expect(device.run(`stat -c %a ${lock}`).trim()).toBe("600");
    const root = `/workspace/lock-${randomUUID().slice(0, 8)}`;
    device.run(`mkdir ${root}`);
    const scope = scopeFor(backend.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
      network: { kind: "none" },
    });
    const probe = await backend.operation(scope, authorityFor(scope.operationId)).exec({
      command: `cat ${lock} 2>&1; echo $?`,
      cwd: root,
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(probe.stdout).toMatch(/Permission denied\n1\n$/);
  });

  // The executor's real layout: workspace and tmp are host directories bind-mounted into the
  // container. Where the mount does not keep Landlock's rules (Docker Desktop's file sharing) the
  // backend reports restricted unavailable and this records why instead of passing vacuously.
  it("local-Docker backend on bind-mounted host directories: passes the full permission conformance", async (context) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-docker-bind-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "workspace"));
    await mkdir(join(dir, "tmp"));
    await chmod(join(dir, "workspace"), 0o777);
    await chmod(join(dir, "tmp"), 0o1777);
    const bound = await startLinuxDevice({ bindWorkspace: dir });
    // Cleanups run in order: before the host removes dir, the container user (uid 1000, which
    // on a Linux host differs from the test's own uid) removes what it created in the bind
    // mounts: directories it made are 0755 and its own, so the host user could not empty them.
    // (A real device runs its container as the host user, so this is a fixture concern.)
    cleanups.unshift(async () => {
      bound.run(
        "chmod -R u+rwX /workspace /tmp 2>/dev/null; find /workspace /tmp -mindepth 1 -delete 2>/dev/null; true",
      );
      bound.remove();
    });
    const server = new HostServer(await localServerFile(dir));
    servers.push(server);
    const state = join(dir, "state");
    await mkdir(state, { mode: 0o700 });
    const backend = await hostBackend(server, {
      stateDir: state,
      deviceId: "device-docker-bind",
      docker: {
        container: bound.name,
        hostRoots: {
          workspace: join(dir, "workspace"),
          skills: join(dir, "s"),
          tmp: join(dir, "tmp"),
        },
      },
    });
    const support = await backend.support();
    if (
      support.restricted === null &&
      /Landlock rules do not hold/.test(support.unavailableReason ?? "")
    )
      return context.skip(`bind mounts here drop Landlock rules: ${support.unavailableReason}`);
    if (required) expect(support.restricted).not.toBeNull();
    await runSandboxPermissionConformance(fixture(bound, backend));
  });
});
