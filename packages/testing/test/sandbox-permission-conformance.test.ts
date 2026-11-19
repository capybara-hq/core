import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ExecResult,
  parseSandboxOperationScope,
  SANDBOX_RESERVED_NAME_PREFIX,
  type SandboxOperation,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionEndpoint,
  type SandboxPermissionFixture,
  type SandboxPermissionGrant,
  type SandboxPermissionTarget,
  waitForFile,
} from "../src/sandbox-permission-conformance.js";

function unsupportedFixture(
  operation: () => Promise<SandboxOperation>,
  granted: Partial<SandboxPermissionEndpoint> = {},
) {
  let disposed = false;
  const support: SandboxPermissionSupport = {
    version: 2,
    restricted: null,
    boundary: "operation",
    network: { openPublic: false, allowlist: false, perOperationHosts: false },
    outsideSandbox: true,
    background: false,
    unavailableReason: "test runtime without restricted primitives",
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected fixture call");
  };
  const fixture: SandboxPermissionFixture = {
    root: "/owned/root",
    sibling: "/owned/sibling",
    protectedPaths: [],
    endpoints: {
      granted: {
        name: "granted.permission.test",
        address: "127.0.0.1",
        port: 1,
        receipts: unexpected,
        ...granted,
      },
      ungranted: [],
      access: "direct",
    },
    support: async () => support,
    operation,
    seed: unexpected,
    inspect: { readFile: unexpected, mode: unexpected, alive: unexpected },
    dispose: async () => {
      disposed = true;
    },
  };
  return { fixture, disposed: () => disposed };
}

describe("permission conformance harness", () => {
  it("accepts an unsupported runtime only when restricted operations fail closed", async () => {
    const { fixture, disposed } = unsupportedFixture(async () => {
      throw new SandboxPermissionUnsupportedError("restricted unavailable");
    });
    await runSandboxPermissionConformance(fixture);
    expect(disposed()).toBe(true);
  });

  it("rejects an unsupported runtime that still runs restricted commands", async () => {
    const { fixture, disposed } = unsupportedFixture(async () => ({
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      }),
      readFile: async () => null,
      writeFile: async () => {},
      stat: async () => null,
    }));
    await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(/refuse restricted/);
    expect(disposed()).toBe(true);
  });

  it("rejects an endpoint whose allowlist name no valid scope could carry", async () => {
    // validateAllowHost refuses IP literals: a granted name of 127.0.0.1 could never be allowlisted.
    const { fixture, disposed } = unsupportedFixture(
      async () => {
        throw new SandboxPermissionUnsupportedError("restricted unavailable");
      },
      { name: "127.0.0.1" },
    );
    await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(
      /granted endpoint name 127\.0\.0\.1 is not a valid allowlist host/,
    );
    expect(disposed()).toBe(true);
  });

  it("rejects an endpoint address that is not numeric", async () => {
    const { fixture } = unsupportedFixture(
      async () => {
        throw new SandboxPermissionUnsupportedError("restricted unavailable");
      },
      { address: "granted.permission.test" },
    );
    await expect(runSandboxPermissionConformance(fixture)).rejects.toThrow(
      /granted endpoint address .* is not a numeric address/,
    );
  });
});

/** The report of an instance-boundary provider (a cloud device). */
const INSTANCE_SUPPORT: SandboxPermissionSupport = {
  version: 2,
  boundary: "instance",
  restricted: null,
  network: { openPublic: true, allowlist: true, perOperationHosts: false },
  outsideSandbox: false,
  background: true,
};
const GRANTED = "granted.permission.test";
const PLANTED = {
  CAPYBARA_SELFTEST_TOKEN: "planted-capybara-token",
  PLANTED_PLAIN: "planted-plain-0b5f",
};
const UNGRANTED = "ungranted.permission.test";

/**
 * A stand-in instance-boundary provider on this machine (no isolation: the "instance" is the host,
 * which is exactly what an instance boundary promises the harness): commands run in their own
 * process group with a minimal environment and an HTTP proxy that forwards only the allowlisted
 * name. `broken` switches one promise off, to prove the harness notices.
 */
async function instanceFixture(
  base: string,
  options: {
    support?: Partial<SandboxPermissionSupport>;
    broken?: "escalated" | "environment-pair" | "environment" | "per-operation-hosts";
  } = {},
): Promise<SandboxPermissionFixture> {
  const root = join(base, `root-${Math.random().toString(36).slice(2, 8)}`);
  const sibling = `${root}-sibling`;
  await mkdir(root, { recursive: true });
  await mkdir(sibling, { recursive: true });
  let accepted = 0;
  const target = createServer((_req, res) => res.end("ok"));
  target.on("connection", () => {
    accepted++;
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as AddressInfo).port;
  // a port nothing listens on: the ungranted endpoint's address
  const closedPort = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  // the instance's outer network: an allowlist proxy for the granted name (broken
  // "per-operation-hosts": also for the hosts the operation names in its proxy credentials)
  const proxy = createServer((req, res) => {
    const to = new URL(req.url ?? "/");
    const credentials = Buffer.from(
      (req.headers["proxy-authorization"] ?? "").replace(/^Basic /, ""),
      "base64",
    ).toString();
    const asked = decodeURIComponent(credentials.split(":")[0] ?? "").split(",");
    if (
      to.hostname !== GRANTED &&
      !(options.broken === "per-operation-hosts" && asked.includes(to.hostname))
    ) {
      res.writeHead(403).end();
      return;
    }
    request({ host: "127.0.0.1", port: targetPort, path: to.pathname, agent: false }, (answer) => {
      res.writeHead(answer.statusCode ?? 502);
      answer.pipe(res);
    })
      .on("error", () => res.writeHead(502).end())
      .end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const servers: Server[] = [target, proxy];
  const support = { ...INSTANCE_SUPPORT, ...options.support };
  let sequence = 0;
  const operation = async (grant: SandboxPermissionGrant): Promise<SandboxOperation> => {
    const scope = {
      operationId: `op-${++sequence}`,
      admitBeforeMs: Date.now() + 60_000,
      deviceId: "instance",
      rootConversationId: "c",
      profileRevision: 0,
      ceilingRevision: "c",
      profile: grant.profile,
      actor: { accountId: "a", conversationId: "c" },
      tag: `op-${sequence}`,
      filesystem: grant.filesystem,
      network: grant.network,
    };
    if (options.broken !== "environment-pair") parseSandboxOperationScope(scope);
    if (grant.filesystem.kind === "device" && options.broken !== "escalated")
      throw new SandboxScopeDeniedError("An instance has no outside to run in");
    const hosts = grant.network.kind === "allowlist" ? grant.network.hosts : [];
    const operationProxy = proxyUrl.replace(
      "http://",
      `http://${encodeURIComponent(hosts.join(","))}:x@`,
    );
    const exec: SandboxOperation["exec"] = (args) =>
      new Promise<ExecResult>((resolve) => {
        const child = spawn("/bin/sh", ["-c", args.command], {
          cwd: args.cwd,
          detached: true,
          env:
            options.broken === "environment"
              ? { ...process.env, http_proxy: operationProxy }
              : {
                  PATH: process.env.PATH ?? "/usr/bin:/bin",
                  HOME: root,
                  http_proxy: operationProxy,
                },
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let killed = false;
        const kill = () => {
          killed = true;
          try {
            process.kill(-(child.pid as number), "SIGKILL");
          } catch {}
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, args.timeoutMs);
        args.signal.addEventListener("abort", kill, { once: true });
        child.stdout.on("data", (b: Buffer) => {
          stdout += b.toString();
        });
        child.stderr.on("data", (b: Buffer) => {
          stderr += b.toString();
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: killed ? null : code, stdout, stderr, truncated: false, timedOut });
        });
      });
    return {
      exec,
      readFile: async (path, { maxBytes }) => {
        const data = await readFile(path).catch(() => null);
        if (data === null) return null;
        return {
          data: new Uint8Array(data.subarray(0, maxBytes)),
          truncated: data.length > maxBytes,
        };
      },
      writeFile: async (path, data) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
      },
      stat: async (path) => {
        const s = await stat(path).catch(() => null);
        return s && { size: s.size, isDir: s.isDirectory() };
      },
      list: async (path, { limit }) => {
        const names = (await readdir(path, { withFileTypes: true })).slice(0, limit);
        return {
          entries: names.map((d) => ({ name: d.name, isDir: d.isDirectory() })),
          truncated: false,
        };
      },
      scan: async () => [],
    };
  };
  return {
    root,
    sibling,
    protectedPaths: [],
    endpoints: {
      granted: {
        name: GRANTED,
        address: "127.0.0.1",
        port: targetPort,
        receipts: async () => accepted,
      },
      ungranted: [
        { name: UNGRANTED, address: "127.0.0.1", port: closedPort, receipts: async () => 0 },
      ],
      access: "proxy",
      // the proxy forwards no other name: a metadata name is refused like any other
      closedGranted: [
        {
          label: "metadata",
          host: "metadata.permission.test",
          port: 80,
          address: "169.254.169.254",
        },
      ],
    },
    instanceNetwork: "allowlist",
    deviceEnvironment: { variables: PLANTED, escalatedControl: false },
    // a host process group: a descendant that left it is not rediscovered
    regroupedDescendants: "not-promised",
    support: async () => support,
    operation,
    seed: async (entries) => {
      for (const entry of entries) {
        await mkdir(entry.kind === "directory" ? entry.path : dirname(entry.path), {
          recursive: true,
        });
        if (entry.kind === "file") await writeFile(entry.path, entry.data);
        else if (entry.kind === "symlink") await symlink(entry.target, entry.path);
      }
    },
    inspect: {
      readFile: async (path) =>
        readFile(path).then(
          (b) => new Uint8Array(b),
          () => null,
        ),
      mode: async (path) =>
        stat(path).then(
          (s) => s.mode & 0o7777,
          () => null,
        ),
      alive: async (pids) =>
        pids.filter((pid) => spawnSync("/bin/kill", ["-0", String(pid)]).status === 0),
    },
    dispose: async () => {
      for (const server of servers) server.closeAllConnections();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}

describe("permission conformance harness: instance boundary", () => {
  let base = "";
  const prior: Record<string, string | undefined> = {};
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "cap-instance-conformance-")));
    for (const [name, value] of Object.entries(PLANTED)) {
      prior[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(async () => {
    for (const [name, value] of Object.entries(prior))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("passes an instance-boundary provider: every profile alike, nothing outside, its outer network", async () => {
    await runSandboxPermissionConformance(await instanceFixture(base));
  });

  it("rejects an instance boundary that runs the escalated pair", async () => {
    await expect(
      runSandboxPermissionConformance(await instanceFixture(base, { broken: "escalated" })),
    ).rejects.toThrow(/must refuse the escalated pair/);
  });

  it("rejects an instance boundary that accepts the environment network without the device filesystem", async () => {
    await expect(
      runSandboxPermissionConformance(await instanceFixture(base, { broken: "environment-pair" })),
    ).rejects.toThrow(/environment network without the device filesystem/);
  });

  it("rejects an instance boundary that claims an outside", async () => {
    await expect(
      runSandboxPermissionConformance(
        await instanceFixture(base, { support: { outsideSandbox: true } }),
      ),
    ).rejects.toThrow(/nothing outside/);
  });

  it("rejects an instance boundary whose operations widen its outer allowlist", async () => {
    await expect(
      runSandboxPermissionConformance(
        await instanceFixture(base, { broken: "per-operation-hosts" }),
      ),
    ).rejects.toThrow(/an ungranted name in the scope's hosts must still be refused/);
  });

  it("rejects an instance boundary without a metadata name behind its allowlist", async () => {
    const fixture = await instanceFixture(base);
    await expect(
      runSandboxPermissionConformance({
        ...fixture,
        endpoints: { ...fixture.endpoints, closedGranted: [] },
      }),
    ).rejects.toThrow(/closedGranted with a name served at a cloud metadata address/);
  });

  it("rejects an instance boundary whose commands inherit the provider's environment", async () => {
    await expect(
      runSandboxPermissionConformance(await instanceFixture(base, { broken: "environment" })),
    ).rejects.toThrow(/no provider variable reaches a command/);
  });
});

/** The report of an operation-boundary provider with restricted support (a local device). */
const OPERATION_SUPPORT: SandboxPermissionSupport = {
  version: 2,
  boundary: "operation",
  restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
  network: { openPublic: true, allowlist: true, perOperationHosts: true },
  outsideSandbox: true,
  background: false,
};
const SCRIPTED_PLANTED = {
  AWS_SECRET_ACCESS_KEY: "scripted-aws-secret",
  CAPYBARA_SCRIPTED_TOKEN: "scripted-capybara-token",
  PLANTED_PLAIN: "scripted-plain-value",
};
type ScriptedBreak =
  | "proxy-502"
  | "closed-receipt"
  | "own-connect"
  | "escalated-capybara"
  | "outside-off"
  | "reserved-name"
  | "link-chain"
  | "denylist";

/** Runs a command on this machine in its own process group (a stand-in has no isolation). */
function hostRun(command: string, cwd: string, env: Record<string, string>): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("close", (code) =>
      resolve({ exitCode: code, stdout, stderr, truncated: false, timedOut: false }),
    );
  });
}

/**
 * A scripted operation-boundary stand-in: the setup and positive controls run on this machine for
 * real, and each approval-only probe the harness sends gets the answer a conforming provider
 * gives (canned), unless `broken` names the one promise to break. It runs only with `checks`: it
 * proves that each approval-only predicate of the harness catches its violation.
 */
async function scriptedFixture(
  base: string,
  broken?: ScriptedBreak,
): Promise<SandboxPermissionFixture> {
  const root = join(base, `scripted-${Math.random().toString(36).slice(2, 8)}`);
  const sibling = `${root}-sibling`;
  const home = `${root}-home`;
  for (const dir of [root, sibling, home]) await mkdir(dir, { recursive: true });
  const counts: Record<string, number> = {};
  const counter = (key: string) => async () => counts[key] ?? 0;
  const seen = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const target = (label: string, host: string): SandboxPermissionTarget => ({
    label,
    host,
    port: 80,
    receipts: counter(label),
  });
  // one literal per closed class
  const closed = [
    target("private", "10.0.0.1"),
    target("cgnat", "100.64.0.1"),
    target("ula", "fd12:3456::1"),
    target("link-local", "169.254.1.1"),
    target("metadata", "169.254.169.254"),
    target("loopback", "127.0.0.1"),
    target("multicast", "224.0.0.251"),
    target("broadcast", "255.255.255.255"),
    target("unspecified", "0.0.0.0"),
    target("nat64", "64:ff9b::a00:1"),
    target("reserved", "240.0.0.1"),
    target("rebinding", "loop.permission.test"),
  ];
  const reachable = [target("public", "public.permission.test")];
  const closedGranted = [target("granted-closed", "closed.permission.test")];
  const closedLabels = new Set([...closed, ...closedGranted].map((t) => t.label));
  let outside = true;
  let release: (() => void) | undefined;
  const served = new Promise<void>((resolve) => {
    release = resolve;
  });
  const minimal = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
  /** The canned answer of a conforming provider to one harness probe, or undefined (run it). */
  const canned = async (command: string, escalated: boolean): Promise<string | undefined> => {
    if (command === "env") {
      if (escalated)
        return Object.entries(SCRIPTED_PLANTED)
          .filter(([name]) => broken === "escalated-capybara" || !name.startsWith("CAPYBARA_"))
          .map(([name, value]) => `${name}=${value}\n`)
          .join("");
      const env =
        broken === "denylist"
          ? Object.fromEntries(
              Object.entries({ ...SCRIPTED_PLANTED, SHELL: "/bin/zsh", ...minimal }).filter(
                ([name]) => !/SECRET|TOKEN|CAPYBARA/.test(name),
              ),
            )
          : minimal;
      return Object.entries(env)
        .map(([name, value]) => `${name}=${value}\n`)
        .join("");
    }
    if (command.includes("curl -sS -m 10")) {
      const viaProxy = command.includes("--noproxy");
      return [...command.matchAll(/printf '%s %s\\n' '([^']+)'/g)]
        .map(([, label]) => {
          const name = label as string;
          if (!closedLabels.has(name)) {
            seen(name);
            return `${name} 200\n`;
          }
          if (broken === "closed-receipt" && name === "loopback") seen(name);
          return `${name} ${viaProxy ? (broken === "proxy-502" ? "502" : "403") : "000"}\n`;
        })
        .join("");
    }
    if (command.includes("SO_REUSEPORT"))
      return `${JSON.stringify({
        "own 127.0.0.1": broken === "own-connect" ? "ok" : "denied",
        "own ::1": "denied",
        reuseport: "denied",
      })}\n`;
    if (command.includes("unspec="))
      return "127.0.0.1=ok ::1=ok 0.0.0.0=denied ::=denied unspec=denied\n";
    if (command.includes("peer.recv(16)")) {
      const portFile = command.split(" ").at(-1)?.replaceAll("'", "") as string;
      await writeFile(portFile, "4242");
      await served;
      return "from-outside\n";
    }
    if (command.includes('("127.0.0.1", 4242)')) {
      release?.();
      return "";
    }
    if (command.includes(SANDBOX_RESERVED_NAME_PREFIX) && broken !== "reserved-name") {
      // what a conforming runtime leaves: the ordinary names only
      await mkdir(join(root, "plain-dir"), { recursive: true });
      await writeFile(join(root, `not${SANDBOX_RESERVED_NAME_PREFIX}f`), "ok");
      return "";
    }
    if (command.startsWith("cd dotfiles") && broken !== "link-chain") return "";
    return undefined;
  };
  let sequence = 0;
  const operation = async (grant: SandboxPermissionGrant): Promise<SandboxOperation> => {
    parseSandboxOperationScope({
      operationId: `op-${++sequence}`,
      admitBeforeMs: Date.now() + 60_000,
      deviceId: "scripted",
      rootConversationId: "c",
      profileRevision: 0,
      ceilingRevision: "c",
      profile: grant.profile,
      actor: { accountId: "a", conversationId: "c" },
      tag: `op-${sequence}`,
      filesystem: grant.filesystem,
      network: grant.network,
    });
    const escalated = grant.filesystem.kind === "device";
    if (escalated && !outside && broken !== "outside-off")
      throw new SandboxScopeDeniedError("Running outside the sandbox is off");
    const refuse = (path: string) => {
      if (path.includes(SANDBOX_RESERVED_NAME_PREFIX) || path.includes("dotfiles/"))
        throw new SandboxScopeDeniedError(`Writing ${path} is outside the scope`);
    };
    return {
      exec: async (args) => {
        const answer = await canned(args.command, escalated);
        if (answer !== undefined)
          return { exitCode: 0, stdout: answer, stderr: "", truncated: false, timedOut: false };
        // not a probe: run it here (the setup and positive controls; the host's own tools)
        return hostRun(args.command, args.cwd ?? root, {
          ...(process.env as Record<string, string>),
        });
      },
      readFile: async (path, { maxBytes }) => {
        const data = await readFile(path).catch(() => null);
        if (data === null) return null;
        return {
          data: new Uint8Array(data.subarray(0, maxBytes)),
          truncated: data.length > maxBytes,
        };
      },
      writeFile: async (path, data) => {
        refuse(path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
      },
      stat: async (path) => {
        const s = await stat(path).catch(() => null);
        return s && { size: s.size, isDir: s.isDirectory() };
      },
      list: async (path, { limit }) => {
        const names = (await readdir(path, { withFileTypes: true })).slice(0, limit);
        return {
          entries: names.map((d) => ({ name: d.name, isDir: d.isDirectory() })),
          truncated: false,
        };
      },
      scan: async () => [],
    };
  };
  return {
    root,
    sibling,
    protectedPaths: [],
    endpoints: {
      granted: {
        name: GRANTED,
        address: "127.0.0.1",
        port: 1,
        receipts: counter("granted"),
      },
      ungranted: [],
      access: "proxy",
      closedGranted,
    },
    openNetwork: { reachable, closed, fakeIp: { unavailable: "a scripted stand-in" } },
    deviceEnvironment: { variables: SCRIPTED_PLANTED, escalatedControl: true },
    withoutOutsideSandbox: async () => {
      outside = false;
      return async () => {
        outside = true;
      };
    },
    home: { path: home, remove: (path) => rm(path, { force: true }) },
    support: async () => OPERATION_SUPPORT,
    operation,
    seed: async (entries) => {
      for (const entry of entries) {
        await mkdir(entry.kind === "directory" ? entry.path : dirname(entry.path), {
          recursive: true,
        });
        if (entry.kind === "file") await writeFile(entry.path, entry.data);
        else if (entry.kind === "symlink") await symlink(entry.target, entry.path);
      }
    },
    inspect: {
      readFile: async (path) =>
        readFile(path).then(
          (b) => new Uint8Array(b),
          () => null,
        ),
      mode: async (path) =>
        stat(path).then(
          (s) => s.mode & 0o7777,
          () => null,
        ),
      alive: async () => [],
    },
    dispose: async () => {},
  };
}

const ALL_CHECKS = [
  "outside-switch",
  "environment",
  "reserved-names",
  "link-chain",
  "closed-granted",
  "loopback",
  "open-network",
] as const;

describe("permission conformance harness: approval-only predicates", () => {
  let base = "";
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "cap-scripted-conformance-")));
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("passes the scripted stand-in on every approval-only check, and reports what it lacks", async () => {
    const report = await runSandboxPermissionConformance(await scriptedFixture(base), {
      checks: ALL_CHECKS,
    });
    expect(report.unavailable).toEqual([
      { item: "open network: fake-IP names", reason: "a scripted stand-in" },
    ]);
  });

  it.each([
    ["proxy-502", "open-network", /must be refused by the proxy \(403\)/],
    ["closed-receipt", "open-network", /loopback must see no connection/],
    ["own-connect", "loopback", /no loopback connect, no SO_REUSEPORT/],
    ["escalated-capybara", "environment", /minus every CAPYBARA_ variable/],
    ["outside-off", "outside-switch", /outside-sandbox setting is off/],
    ["reserved-name", "reserved-names", /reserved name/],
    ["link-chain", "link-chain", /no hop of a protected chain is writable/],
    ["denylist", "environment", /no device variable reaches a sandboxed command/],
  ] as const)("rejects a provider that breaks %s (%s)", async (broken, check, message) => {
    await expect(
      runSandboxPermissionConformance(await scriptedFixture(base, broken), { checks: [check] }),
    ).rejects.toThrow(message);
  });

  it("rejects a minimal-looking environment that carries extra names", async () => {
    const fixture = await scriptedFixture(base);
    await expect(
      runSandboxPermissionConformance(
        {
          ...fixture,
          // the provider adds names it never stated (a filtered copy of the device's)
          deviceEnvironment: { variables: SCRIPTED_PLANTED, escalatedControl: true, allowed: [] },
          operation: async (grant) => {
            const operation = await fixture.operation(grant);
            return {
              ...operation,
              exec: async (args) =>
                args.command === "env" && grant.filesystem.kind === "scoped"
                  ? {
                      exitCode: 0,
                      stdout: "PATH=/bin\nSHELL=/bin/zsh\nUSER=owner\n",
                      stderr: "",
                      truncated: false,
                      timedOut: false,
                    }
                  : operation.exec(args),
            };
          },
        },
        { checks: ["environment"] },
      ),
    ).rejects.toThrow(/minimal environment only/);
  });

  it("refuses an empty parts or checks list", async () => {
    await expect(
      runSandboxPermissionConformance(await scriptedFixture(base), { parts: [] }),
    ).rejects.toThrow(/parts must not be empty/);
    await expect(
      runSandboxPermissionConformance(await scriptedFixture(base), { checks: [] }),
    ).rejects.toThrow(/checks must not be empty/);
  });

  it("requires the approval-only inputs of a provider with restricted support", async () => {
    const fixture = await scriptedFixture(base);
    const { withoutOutsideSandbox: _off, ...noSwitch } = fixture;
    await expect(
      runSandboxPermissionConformance(noSwitch, { checks: ["environment"] }),
    ).rejects.toThrow(/withoutOutsideSandbox is required/);
    await expect(
      runSandboxPermissionConformance(
        {
          ...(await scriptedFixture(base)),
          deviceEnvironment: {
            variables: { AWS_SECRET_ACCESS_KEY: "x" },
            escalatedControl: false,
          },
        },
        { checks: ["environment"] },
      ),
    ).rejects.toThrow(/innocent-looking/);
    const unlisted = await scriptedFixture(base);
    await expect(
      runSandboxPermissionConformance(
        {
          ...unlisted,
          endpoints: {
            granted: unlisted.endpoints.granted,
            ungranted: unlisted.endpoints.ungranted,
            access: unlisted.endpoints.access,
          },
        },
        { checks: ["environment"] },
      ),
    ).rejects.toThrow(/closedGranted is required/);
  });

  it("fails an open network without any reachable target unless allowNoPositive is set", async () => {
    const fixture = await scriptedFixture(base);
    const offline = {
      ...(fixture.openNetwork as NonNullable<typeof fixture.openNetwork>),
      reachable: { unavailable: "offline" },
    };
    await expect(
      runSandboxPermissionConformance(
        { ...fixture, openNetwork: offline },
        { checks: ["open-network"] },
      ),
    ).rejects.toThrow(/needs a reachable public target/);
    const report = await runSandboxPermissionConformance(
      { ...(await scriptedFixture(base)), openNetwork: { ...offline, allowNoPositive: true } },
      { checks: ["open-network"] },
    );
    expect(report.unavailable.map((u) => u.item)).toContain("open network: public targets");
  });
});

describe("waitForFile", () => {
  const never = new Promise<never>(() => {});

  it("returns once the file appears", async () => {
    let reads = 0;
    await waitForFile(async () => (++reads < 3 ? null : new Uint8Array()), "/r/ready", never);
    expect(reads).toBe(3);
  });

  it("fails with the operation's error when the operation is refused first", async () => {
    const refused = Promise.reject(new SandboxPermissionUnsupportedError("refused here"));
    await expect(waitForFile(async () => null, "/r/ready", refused)).rejects.toThrow(
      /operation ended before \/r\/ready existed: .*refused here/,
    );
  });

  it("fails promptly when the operation exits without writing the file", async () => {
    const exited = Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: "no such file",
      truncated: false,
      timedOut: false,
    });
    await expect(waitForFile(async () => null, "/r/ready", exited)).rejects.toThrow(
      /operation ended before \/r\/ready existed: exit 2: no such file/,
    );
  });

  it("accepts a file the operation wrote just before it ended", async () => {
    let reads = 0;
    const ended = Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    // The first read misses, the operation has ended by the check, a final read sees the file.
    await waitForFile(
      async () => {
        await ended;
        return ++reads < 2 ? null : new Uint8Array();
      },
      "/r/ready",
      ended,
    );
    expect(reads).toBe(2);
  });
});
