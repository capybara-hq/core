import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_HOME_DIRS } from "../../device/src/exec/shared.js";
// The device's own test helpers (the device package may not depend on this one, so its backends
// meet the harness here): a hardened container with endpoints, and the bundled backend server.
import {
  dockerUnavailable,
  type FixtureNetworks,
  inspect,
  type LinuxDevice,
  NAMES,
  scopeFor,
  startLinuxDevice,
} from "../../device/test/linux-docker-fixture.js";
import {
  type HostBackend,
  HostServer,
  hostBackend,
  installServer,
  localServerFile,
  openAuthorityFor,
} from "../../device/test/linux-host-fixture.js";
import type { NativeFixtureEntry } from "../src/sandbox-native-conformance.js";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionEndpoint,
  type SandboxPermissionFixture,
  type SandboxPermissionTarget,
} from "../src/sandbox-permission-conformance.js";

const unavailable = dockerUnavailable();
const required = process.env.CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED === "1";

describe.runIf(required && unavailable !== null)("Linux restricted runtime is required", () => {
  it("has Docker and the sandbox image", () => {
    throw new Error(`CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${unavailable}`);
  });
});

/** Planted in the device process's environment: no sandboxed command may see them. */
const PLANTED = {
  AWS_SECRET_ACCESS_KEY: "planted-aws-secret-0d1e",
  CAPYBARA_TEST_DEVICE_TOKEN: "planted-capybara-token-7f3a",
  // an innocent-looking name: only a minimal environment keeps it out, never a denylist
  PLANTED_PLAIN: randomUUID(),
};

/** The device options of every backend here: the open network under the production rules. */
const backendOptions = (net: FixtureNetworks) => ({
  network: "open" as const,
  allowedDomains: [],
  // production forwarder rules: the fixture's local addresses are closed like any other
  privateProxyTargets: false,
  fakeIpDns: net.doh,
});

/**
 * The conformance fixture over a device backend whose operations run in the container. The device
 * sits on the open-network fixture's two internal networks (a globally routable subnet standing in
 * for the internet, and a private one) and reaches names only through its operation's proxy.
 */
function fixture(
  device: LinuxDevice,
  backend: HostBackend,
  options: { escalatedEnvironment: boolean; home: boolean },
): SandboxPermissionFixture {
  const net = device.networks as FixtureNetworks;
  const id = randomUUID().slice(0, 8);
  const root = `/workspace/project-${id}`;
  const sibling = `/workspace/sibling-${id}`;
  device.run(`mkdir ${root} ${sibling} && printf rc > /home/sandbox/.profile-${id}`);
  const inDevice = (key: string) => async () => {
    const value = (await inspect(device, {
      what: "read",
      path: `/opt/capybara-receipts/${key}`,
    })) as string | null;
    return value === null ? 0 : Number(Buffer.from(value, "base64").toString());
  };
  const endpoint = (
    name: string,
    address: string,
    port: number,
    receipts: () => Promise<number>,
  ): SandboxPermissionEndpoint => ({ name, address, port, receipts });
  const atServer = (key: "public" | "public80" | "private" | "private80") => async () =>
    net.accepted(key);
  const target = (
    label: string,
    host: string,
    port: number,
    receipts?: () => Promise<number>,
    address?: string,
  ): SandboxPermissionTarget => ({
    label,
    host,
    port,
    ...(receipts ? { receipts } : {}),
    ...(address ? { address } : {}),
  });
  const s = net.server;
  const v4 = inDevice("ungranted4");
  const v6 = inDevice("ungranted6");
  const pub = atServer("public");
  const priv = atServer("private");
  const read = async (path: string) => {
    const value = (await inspect(device, { what: "read", path })) as string | null;
    return value === null ? null : new Uint8Array(Buffer.from(value, "base64"));
  };
  return {
    root,
    sibling,
    protectedPaths: [`/home/sandbox/.profile-${id}`],
    endpoints: {
      // the allowlist reaches web ports at public addresses only
      granted: endpoint("allowed.permission.test", s.public, 80, atServer("public80")),
      ungranted: [
        endpoint(NAMES.ungranted4, "127.0.0.1", 18081, v4),
        endpoint(NAMES.ungranted6, "::1", 18082, v6),
        endpoint("private.permission.test", s.private, net.port, priv),
      ],
      // allowlisted names are reached only through the operation's own proxy
      access: "proxy",
      closedGranted: [
        target("granted-private", "private.permission.test", 80, atServer("private80")),
      ],
    },
    openNetwork: {
      reachable: [
        target("public-name", "public.permission.test", net.port, pub, s.public),
        target("public-literal", s.public, net.port, pub, s.public),
      ],
      closed: [
        target("private-name", "private.permission.test", net.port, priv),
        target("private-literal", s.private, net.port, priv),
        target("private-mapped", `::ffff:${s.private}`, net.port, priv),
        target("mapped-name", "mapped.permission.test", net.port, priv),
        target("nat64-name", "nat64.permission.test", net.port, priv),
        target("nat64-literal", `64:ff9b::${s.private}`, net.port, priv),
        target("metadata-name", "metadata.permission.test", 80),
        target("ula", "fd12:3456::1", 80),
        target("link-local", "169.254.1.1", 80),
        target("link-local6", "fe80::1", 80),
        target("multicast", "224.0.0.251", 80),
        target("broadcast", "255.255.255.255", 80),
        target("reserved", "240.0.0.1", 80),
        target("benchmark", "198.18.0.1", 80),
        target("metadata", "169.254.169.254", 80),
        target("metadata-mapped", "::ffff:169.254.169.254", 80),
        target("azure-name", "azure.permission.test", 80),
        target("azure", "168.63.129.16", 80),
        target("cgnat-name", "cgnat.permission.test", 80),
        target("cgnat", "100.64.0.1", 80),
        target("documentation", "192.0.2.1", 80),
        target("loopback-name", "loop.permission.test", 18081, v4),
        target("localhost", "localhost", 18081, v4),
        target("loopback", "127.0.0.1", 18081, v4),
        target("loopback6", "::1", 18082, v6),
        target("unspecified", "0.0.0.0", 18081, v4),
        target("self-name", "self.permission.test", 18083),
        target("self", net.self, 18083),
      ],
      fakeIp: {
        reachable: [target("fake-public", "fake.permission.test", net.port, pub)],
        closed: [
          target("fake-private", "fakepriv.permission.test", net.port, priv),
          target("fake-down", "fakedown.permission.test", net.port),
        ],
      },
    },
    deviceEnvironment: {
      variables: PLANTED,
      escalatedControl: options.escalatedEnvironment,
      // the tool homes the device passes through (version managers' data directories)
      allowed: TOOL_HOME_DIRS.map(([name]) => name),
    },
    withoutOutsideSandbox: async () => {
      await backend.server.call({
        op: "ceiling",
        ceiling: { ...backend.ceiling, revision: "no-outside", outsideSandbox: false },
      });
      return async () => {
        await backend.server.call({ op: "ceiling", ceiling: backend.ceiling });
      };
    },
    home: options.home
      ? {
          // the device process's home (the image gives the device user its own)
          path: device.run(`node -e "process.stdout.write(require('os').homedir())"`).trim(),
          remove: async (path: string) => {
            device.run(`rm -f ${path}`);
          },
        }
      : {
          unavailable:
            "a local-Docker device protects no home: its commands run in the device's container, " +
            "whose home is the image's, and the owner's home is never mounted there",
        },
    support: () => backend.support(),
    operation: async (grant) => {
      const scope = scopeFor(backend.deviceId, grant);
      return backend.operation(scope, openAuthorityFor(scope.operationId));
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

const PARTS = ["filesystem", "network", "processes"] as const;

// The capybara-device Linux operation backends against the full permission conformance in a
// hardened container (aarch64 locally; x86_64 on CI with CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1),
// in its three parts (one test each keeps every part within the test timeout).
describe.skipIf(unavailable !== null)("capybara-device Linux operation backends", () => {
  let device: LinuxDevice;
  const servers: HostServer[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const backends: Partial<Record<"host" | "docker" | "bind", HostBackend>> = {};
  const devices: Partial<Record<"host" | "docker" | "bind", LinuxDevice>> = {};
  let bindSkip = "";

  beforeAll(async () => {
    device = await startLinuxDevice({ networks: true });
    await installServer(device);
    const net = device.networks as FixtureNetworks;

    // the Linux host backend: the device process runs in the container
    device.run("mkdir -m 700 /home/sandbox/state-host");
    const host = new HostServer(device, PLANTED);
    servers.push(host);
    backends.host = await hostBackend(host, {
      stateDir: "/home/sandbox/state-host",
      ...backendOptions(net),
    });
    devices.host = device;

    // the local-Docker backend: the device process runs here, its agents in the container
    const dir = await mkdtemp(join(tmpdir(), "cap-docker-backend-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const local = new HostServer(await localServerFile(dir), PLANTED);
    servers.push(local);
    await mkdir(join(dir, "state"), { mode: 0o700 });
    backends.docker = await hostBackend(local, {
      stateDir: join(dir, "state"),
      deviceId: "device-docker",
      docker: {
        container: device.name,
        hostRoots: { workspace: join(dir, "w"), skills: join(dir, "s"), tmp: join(dir, "t") },
      },
      ...backendOptions(net),
    });
    devices.docker = device;

    // The executor's real layout: workspace and tmp are host directories bind-mounted into the
    // container. Where the mount does not keep Landlock's rules (Docker Desktop's file sharing)
    // the backend reports restricted unavailable and the parts record why instead of passing
    // vacuously.
    const bindDir = await realpath(await mkdtemp(join(tmpdir(), "cap-docker-bind-")));
    cleanups.push(() => rm(bindDir, { recursive: true, force: true }));
    await mkdir(join(bindDir, "workspace"));
    await mkdir(join(bindDir, "tmp"));
    await chmod(join(bindDir, "workspace"), 0o777);
    await chmod(join(bindDir, "tmp"), 0o1777);
    const bound = await startLinuxDevice({ bindWorkspace: bindDir, networks: true });
    // Cleanups run in order: before the host removes bindDir, the container user (uid 1000, which
    // on a Linux host differs from the test's own uid) removes what it created in the bind
    // mounts: directories it made are 0755 and its own, so the host user could not empty them.
    // (A real device runs its container as the host user, so this is a fixture concern.)
    cleanups.unshift(async () => {
      bound.run(
        "chmod -R u+rwX /workspace /tmp 2>/dev/null; find /workspace /tmp -mindepth 1 -delete 2>/dev/null; true",
      );
      bound.remove();
    });
    const bindServer = new HostServer(await localServerFile(bindDir), PLANTED);
    servers.push(bindServer);
    await mkdir(join(bindDir, "state"), { mode: 0o700 });
    backends.bind = await hostBackend(bindServer, {
      stateDir: join(bindDir, "state"),
      deviceId: "device-docker-bind",
      docker: {
        container: bound.name,
        hostRoots: {
          workspace: join(bindDir, "workspace"),
          skills: join(bindDir, "s"),
          tmp: join(bindDir, "tmp"),
        },
      },
      ...backendOptions(bound.networks as FixtureNetworks),
    });
    devices.bind = bound;
    const support = await backends.bind.support();
    if (
      support.restricted === null &&
      /Landlock rules do not hold/.test(support.unavailableReason ?? "")
    )
      bindSkip = `bind mounts here drop Landlock rules: ${support.unavailableReason}`;
  });
  afterAll(async () => {
    for (const server of servers) server.close();
    for (const cleanup of cleanups) await cleanup();
    device?.remove();
  });

  for (const [kind, label] of [
    ["host", "Linux host backend"],
    ["docker", "local-Docker backend"],
    ["bind", "local-Docker backend on bind-mounted host directories"],
  ] as const)
    for (const part of PARTS)
      it(`${label}: passes the permission conformance: ${part}`, async (context) => {
        if (kind === "bind" && bindSkip) return context.skip(bindSkip);
        const backend = backends[kind] as HostBackend;
        const support = await backend.support();
        if (required) expect(support.restricted).not.toBeNull();
        const report = await runSandboxPermissionConformance(
          fixture(devices[kind] as LinuxDevice, backend, {
            // the local-Docker device's escalated calls run in its container, whose environment
            // is the container's, not the device process's
            escalatedEnvironment: kind === "host",
            // the Linux host's workers resolve the protected home locations in the container
            home: kind === "host",
          }),
          { parts: [part] },
        );
        for (const { item, reason } of report.unavailable)
          await context.annotate(`unavailable: ${item}: ${reason}`);
      });
});
