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
const PLANTED = { CAPYBARA_SELFTEST_TOKEN: "planted-capybara-token" };

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
    broken?: "escalated" | "environment-pair" | "environment";
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
  // the instance's outer network: an allowlist proxy for the granted name
  const proxy = createServer((req, res) => {
    const to = new URL(req.url ?? "/");
    if (to.hostname !== GRANTED) {
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
    const exec: SandboxOperation["exec"] = (args) =>
      new Promise<ExecResult>((resolve) => {
        const child = spawn("/bin/sh", ["-c", args.command], {
          cwd: args.cwd,
          detached: true,
          env:
            options.broken === "environment"
              ? { ...process.env, http_proxy: proxyUrl }
              : { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, http_proxy: proxyUrl },
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
      ungranted: [],
      access: "proxy",
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

  it("rejects an instance boundary whose commands inherit the provider's environment", async () => {
    await expect(
      runSandboxPermissionConformance(await instanceFixture(base, { broken: "environment" })),
    ).rejects.toThrow(/no provider variable reaches a command/);
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
