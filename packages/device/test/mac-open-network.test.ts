import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecResult, type SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type DeviceOwnerCeiling,
  intersectOperation,
  type LocalOperationGrant,
} from "../src/exec/operation-types.js";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// The open network on macOS (approval-only profiles design, "Open network"): a restricted command
// reaches the public internet through the operation's own proxy, which decides on the resolved
// address; private, CGNAT, ULA, link-local, metadata, NAT64 and loopback destinations stay closed,
// for IP literals and for names resolving there. Real Seatbelt, real proxy.
//
// The positive reach needs the internet: it runs only when this process reaches https://1.1.1.1
// itself. A public name is reached also behind a fake-IP resolver (a router answering every name
// with 198.18/15): the proxy re-resolves it through DNS-over-HTTPS. The decisions for names are
// also covered offline in mac-srt-network-patch.test.ts.

const darwin = process.platform === "darwin";
const workspace = { runtimeHash: "", cleanup: async () => {} };
let root = "";
let server: Server | undefined;
let port = 0;
const receipts: string[] = [];
let internet = false;

/** Whether this process connects to `host:port` within 3 s. */
function reachable(host: string, to: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: to, timeout: 3000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

beforeAll(async () => {
  if (!darwin) return;
  Object.assign(workspace, await sealWorkspaceRuntime());
  root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-open-")));
  server = createServer((req, res) => {
    receipts.push(req.url ?? "");
    res.end("loopback-response");
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  port = address.port;
  internet = await reachable("1.1.1.1", 443);
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await workspace.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

const signal = () => AbortSignal.timeout(50_000);

/** One sandboxed command under `grant` (the open network unless the grant says otherwise). */
async function run(
  command: string,
  grant: Partial<LocalOperationGrant> = {},
  extra: { scope?: SandboxOperationScope; home?: string } = {},
): Promise<ExecResult> {
  const project = await mkdtemp(join(root, "project-"));
  const state = await mkdtemp(join(root, "state-"));
  const worker = await startMacOperationWorker(
    {
      kind: "exec",
      scope: extra.scope ?? ({ operationId: "open", tag: "open" } as never),
      grant: {
        full: false,
        openNetwork: true,
        readRoots: [project],
        writeRoots: [project],
        hosts: [],
        deniedReadRoots: [state],
        revision: "r",
        ...grant,
      },
      args: { command, cwd: project, timeoutMs: 40_000, maxOutputBytes: 1 << 16 },
      stateDir: state,
      pythonPath: "/usr/bin/python3",
      runtimeHash: workspace.runtimeHash,
      ...(extra.home ? { toolHome: { home: extra.home, env: { HOME: extra.home } } } : {}),
      beforeLaunch: async () => {},
      onLaunch: async () => {},
    },
    signal(),
  );
  return (await worker.completion) as ExecResult;
}

/** `curl` through the operation's proxy, printing one `<label>:<HTTP status>` line per URL. */
const probes = (urls: Record<string, string>) =>
  Object.entries(urls)
    .map(
      ([label, url]) =>
        `printf '${label}:%s\\n' "$(/usr/bin/curl --silent --output /dev/null --max-time 8 --noproxy '' --write-out '%{http_code}' '${url}')"`,
    )
    .join("; ");

const statuses = (stdout: string) =>
  Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split(":") as [string, string]),
  );

it.runIf(darwin)(
  "the open network refuses private, metadata, NAT64 and loopback destinations, by literal and by name",
  async () => {
    receipts.length = 0;
    const urls = {
      loopback: `http://127.0.0.1:${port}/loopback`,
      loopbackOther: `http://127.0.0.2:${port}/loopback-other`,
      localhost: `http://localhost:${port}/localhost`,
      ipv6Loopback: `http://[::1]:${port}/ipv6`,
      mapped: `http://[::ffff:127.0.0.1]:${port}/mapped`,
      inetAton: `http://2130706433:${port}/inet-aton`,
      private10: "http://10.0.0.1/",
      private192: "http://192.168.1.1/",
      private172: "http://172.16.0.1/",
      cgnat: "http://100.64.0.1/",
      ula: "http://[fd12:3456::1]/",
      linkLocal: "http://169.254.169.254/latest/meta-data/",
      metadataName: "http://2852039166/latest/meta-data/",
      azure: "http://168.63.129.16/",
      awsV6: "http://[fd00:ec2::254]/",
      nat64: "http://[64:ff9b::a00:1]/",
      benchmark: "http://198.18.0.1/",
    };
    const result = await run(probes(urls));
    expect(result.exitCode, result.stderr).toBe(0);
    const seen = statuses(result.stdout);
    // the proxy answers its refusal itself (403), without dialing
    for (const label of Object.keys(urls))
      expect(seen[label], `${label}: ${result.stdout}`).toBe("403");
    expect(receipts).toEqual([]);
  },
);

it.runIf(darwin)("a loopback port is not reachable directly either", async () => {
  receipts.length = 0;
  const result = await run(
    `/usr/bin/curl --silent --max-time 5 --noproxy '*' http://127.0.0.1:${port}/direct; printf 'exit:%s' "$?"`,
  );
  expect(result.stdout).not.toContain("loopback-response");
  expect(result.stdout).toMatch(/exit:[1-9]/);
  expect(receipts).toEqual([]);
});

it.runIf(darwin)("an allowlist grant still reaches exactly its hosts", async () => {
  receipts.length = 0;
  const result = await run(
    probes({
      granted: `http://127.0.0.1:${port}/granted`,
      other: "http://10.0.0.1/",
    }),
    { openNetwork: false, hosts: [`127.0.0.1:${port}`] },
  );
  expect(statuses(result.stdout)).toMatchObject({ granted: "200", other: "403" });
  expect(receipts).toEqual(["/granted"]);
});

it.runIf(darwin)("listening stays refused in the open network", async () => {
  const result = await run(
    `/usr/bin/python3 -I -c 'import socket
s = socket.socket()
try:
    s.bind(("127.0.0.1", 0)); s.listen(); print("listening")
except OSError as e:
    print("refused", e.errno)'`,
  );
  expect(result.stdout, result.stderr).toMatch(/^refused/);
});

it.runIf(darwin)("the open network reaches a public address literal", async (context) => {
  if (!internet) context.skip("no internet: the public reach is covered by the guard tests only");
  const result = await run(probes({ literal: "https://1.1.1.1/" }));
  // the server's own answer (a redirect or a page), not the proxy's refusal (403) or none (000)
  expect(statuses(result.stdout).literal, result.stderr).toMatch(/^[23]\d\d$/);
});

it.runIf(darwin)(
  "the open network reaches a public name, behind a fake-IP resolver too",
  async (context) => {
    if (!internet) context.skip("no internet: https://1.1.1.1 is unreachable from this process");
    const result = await run(probes({ name: "https://one.one.one.one/" }));
    expect(statuses(result.stdout).name, result.stderr).toMatch(/^[23]\d\d$/);
  },
);

it.runIf(darwin)(
  "a protected home location linked into a write root is not writable at its target",
  async () => {
    const home = await mkdtemp(join(root, "home-"));
    const dotfiles = await mkdtemp(join(root, "dotfiles-"));
    await mkdir(join(dotfiles, "config", "systemd", "user"), { recursive: true });
    await mkdir(join(dotfiles, "launch"), { recursive: true });
    await mkdir(join(home, "Library"));
    await symlink(join(dotfiles, "config"), join(home, ".config"));
    await symlink(join(dotfiles, "launch"), join(home, "Library", "LaunchAgents"));
    await writeFile(join(dotfiles, "zshrc"), "# rc\n");
    await symlink(join(dotfiles, "zshrc"), join(home, ".zshrc"));
    const result = await run(
      [
        `printf x > ${join(dotfiles, "config/systemd/user/evil.service")}`,
        `printf x > ${join(dotfiles, "launch/evil.plist")}`,
        `printf x >> ${join(dotfiles, "zshrc")}`,
        `mkdir -p ${join(dotfiles, "config/autostart")}`,
        `printf ok > ${join(dotfiles, "plain")}`,
        "true",
      ].join("; "),
      { readRoots: [dotfiles], writeRoots: [dotfiles] },
      { home },
    );
    expect(existsSync(join(dotfiles, "plain")), result.stderr).toBe(true);
    expect(existsSync(join(dotfiles, "config/systemd/user/evil.service"))).toBe(false);
    expect(existsSync(join(dotfiles, "launch/evil.plist"))).toBe(false);
    expect(existsSync(join(dotfiles, "config/autostart"))).toBe(false);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dotfiles, "zshrc"), "utf8")).toBe("# rc\n");
  },
);

const fullAccessScope = (
  filesystem: SandboxOperationScope["filesystem"],
  network: SandboxOperationScope["network"],
): SandboxOperationScope => ({
  operationId: "full",
  admitBeforeMs: Date.now() + 60_000,
  deviceId: "d",
  rootConversationId: "r",
  profileRevision: 0,
  ceilingRevision: "c",
  profile: "full-access",
  actor: { accountId: "a", conversationId: "r" },
  tag: "full",
  filesystem,
  network,
});

it.runIf(darwin)(
  "a Full access call that is not escalated stays sandboxed: no secret path, no device environment",
  async () => {
    const home = await mkdtemp(join(root, "home-"));
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "id_ed25519"), "secret-key");
    await writeFile(join(home, "notes"), "plain-notes");
    const ceiling: DeviceOwnerCeiling = {
      revision: "c",
      outsideSandbox: true,
      network: "open",
      allowedDomains: [],
      roots: { workspace: home, skills: join(root, "skills"), tmp: join(root, "tmp") },
      restrictedProjectReach: "os-user",
      restrictedDeniedReadRoots: [join(home, ".ssh")],
      preparation: { skillsRoot: join(root, "skills"), attachmentsBase: join(home, "attachments") },
    };
    const scope = fullAccessScope(
      { kind: "scoped", readRoots: [home], writeRoots: [] },
      { kind: "open-public" },
    );
    const grant = intersectOperation(scope, ceiling, {
      operationId: "full",
      orgNetwork: { kind: "open-public", hosts: [] },
    });
    expect(grant.full).toBe(false);
    process.env.AWS_SECRET_ACCESS_KEY = "aws-sentinel";
    process.env.CAPYBARA_DEVICE_SENTINEL = "device-sentinel";
    try {
      const result = await run(
        `/bin/cat ${join(home, "notes")}; echo; /bin/cat ${join(home, ".ssh/id_ed25519")}; echo; printf 'env:%s|%s' "\${AWS_SECRET_ACCESS_KEY-}" "\${CAPYBARA_DEVICE_SENTINEL-}"`,
        grant,
        { scope },
      );
      expect(result.stdout).toContain("plain-notes");
      expect(result.stdout).not.toContain("secret-key");
      expect(result.stdout).toContain("env:|");
      expect(result.stdout).not.toContain("sentinel");
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.CAPYBARA_DEVICE_SENTINEL;
    }
  },
);

it.runIf(darwin)(
  "an escalated call runs with the owner's environment minus every CAPYBARA_ variable",
  async () => {
    process.env.CAPYBARA_DEVICE_SENTINEL = "device-sentinel";
    process.env.OWNER_SENTINEL = "owner-sentinel";
    try {
      const scope = fullAccessScope({ kind: "device" }, { kind: "environment" });
      // only the sentinels and a count: never the owner's whole environment in a test log
      const result = await run(
        `printf '%s|%s|' "\${OWNER_SENTINEL-}" "\${CAPYBARA_DEVICE_SENTINEL-}"; /usr/bin/env | /usr/bin/grep -c '^CAPYBARA_'; true`,
        {
          full: true,
          openNetwork: false,
          readRoots: ["/"],
          writeRoots: ["/"],
          deniedReadRoots: [],
        },
        { scope },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("owner-sentinel||0");
    } finally {
      delete process.env.CAPYBARA_DEVICE_SENTINEL;
      delete process.env.OWNER_SENTINEL;
    }
  },
);

it.runIf(darwin)("the unwrapped branch runs only for the escalated pair", async () => {
  const scope = fullAccessScope(
    { kind: "scoped", readRoots: ["/"], writeRoots: [] },
    { kind: "open-public" },
  );
  await expect(
    run("true", { full: true, openNetwork: false, readRoots: ["/"], writeRoots: ["/"] }, { scope }),
  ).rejects.toThrow(/escalated/);
});
