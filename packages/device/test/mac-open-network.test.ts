import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult, SandboxOperationScope } from "@capybara-hq/plugin-sdk";
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
  extra: { scope?: SandboxOperationScope; home?: string; allowPrivate?: boolean } = {},
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
      ...(extra.allowPrivate ? { allowPrivateProxyTargets: true } : {}),
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

/** `curl` through the proxy's CONNECT tunnel: the proxy's own answer to CONNECT per URL. */
const connectProbes = (urls: Record<string, string>) =>
  Object.entries(urls)
    .map(
      ([label, url]) =>
        `printf '${label}:%s\n' "$(/usr/bin/curl --silent --output /dev/null --max-time 8 --noproxy '' --proxytunnel --write-out '%{http_connect}' '${url}')"`,
    )
    .join("; ");

/** `curl` through the proxy's SOCKS5 side (names resolved by the proxy): curl's exit per URL. */
const socksProbes = (urls: Record<string, string>) =>
  Object.entries(urls)
    .map(
      ([label, url]) =>
        `/usr/bin/curl --silent --output /dev/null --max-time 8 --noproxy '' --socks5-hostname "\${FTP_PROXY#socks5h://}" '${url}'; printf '${label}:%s\n' "$?"`,
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

it.runIf(darwin)(
  "CONNECT tunnels and SOCKS5 refuse the same destinations, in any literal spelling",
  async () => {
    receipts.length = 0;
    const result = await run(
      [
        connectProbes({
          mapped: "https://[::ffff:10.0.0.1]/",
          hex: `https://0x7f.1:${port}/`,
          metadata: "https://169.254.169.254/",
          localhost: `https://localhost:${port}/`,
        }),
        socksProbes({
          socksPrivate: "http://10.0.0.1/",
          socksLoopback: `http://127.0.0.1:${port}/socks`,
          socksLocalhost: `http://localhost:${port}/socks-name`,
          socksMetadata: "http://169.254.169.254/",
        }),
      ].join("; "),
    );
    const seen = statuses(result.stdout);
    for (const label of ["mapped", "hex", "metadata", "localhost"])
      expect(seen[label], `${label}: ${result.stdout}`).toBe("403");
    // 97: the SOCKS5 proxy refused the connection
    for (const label of ["socksPrivate", "socksLoopback", "socksLocalhost", "socksMetadata"])
      expect(seen[label], `${label}: ${result.stdout}`).toBe("97");
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
  // the fixture listens on loopback, which only the trusted test seam reopens
  const result = await run(
    probes({
      granted: `http://127.0.0.1:${port}/granted`,
      other: "http://10.0.0.1/",
    }),
    { openNetwork: false, hosts: [`127.0.0.1:${port}`] },
    { allowPrivate: true },
  );
  expect(statuses(result.stdout)).toMatchObject({ granted: "200", other: "403" });
  expect(receipts).toEqual(["/granted"]);
});

it.runIf(darwin)(
  "the allowlist refuses a granted private, loopback or metadata destination too",
  async () => {
    receipts.length = 0;
    const result = await run(
      probes({
        loopback: `http://127.0.0.1:${port}/granted-loopback`,
        localhost: `http://localhost:${port}/granted-localhost`,
        private10: "http://10.0.0.1/",
        metadata: "http://169.254.169.254/",
      }),
      {
        openNetwork: false,
        hosts: [`127.0.0.1:${port}`, `localhost:${port}`, "10.0.0.1", "169.254.169.254"],
      },
    );
    expect(statuses(result.stdout)).toEqual({
      loopback: "403",
      localhost: "403",
      private10: "403",
      metadata: "403",
    });
    expect(receipts).toEqual([]);
  },
);

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

// A command's private, link-local or loopback destination goes to the operation's proxy too, so
// the client gets the proxy's refusal (a 403), never a bare "Couldn't connect to server" from a
// direct connect Seatbelt refused (R3 Mac acceptance, B3).
it.runIf(darwin)(
  "a private destination goes to the proxy and gets its refusal, with the default proxy settings",
  async () => {
    receipts.length = 0;
    const result = await run(
      [
        `printf 'no_proxy:%s|%s\\n' "\${NO_PROXY-}" "\${no_proxy-}"`,
        `printf 'lan:%s\\n' "$(/usr/bin/curl --silent --output /dev/null --max-time 8 --write-out '%{http_code}' http://192.168.1.1/)"`,
        `printf 'link:%s\\n' "$(/usr/bin/curl --silent --output /dev/null --max-time 8 --write-out '%{http_code}' http://169.254.169.254/)"`,
        `printf 'loopback:%s\\n' "$(/usr/bin/curl --silent --output /dev/null --max-time 8 --write-out '%{http_code}' http://127.0.0.1:${port}/default)"`,
        `/usr/bin/curl --silent --show-error --output /dev/null --max-time 8 https://10.0.0.1/ 2>&1; printf '\\ntunnel:%s\\n' "$?"`,
      ].join("; "),
    );
    const seen = statuses(
      result.stdout
        .split("\n")
        .filter((l) => /^(no_proxy|lan|link|loopback|tunnel):/.test(l))
        .join("\n"),
    );
    expect(seen.no_proxy, result.stdout).toBe("|");
    expect(seen, result.stdout).toMatchObject({ lan: "403", link: "403", loopback: "403" });
    // curl 8's wording of the proxy refusing a tunnel, which the kernel reads as a sandbox signal
    expect(result.stdout).toContain("CONNECT tunnel failed, response 403");
    expect(seen.tunnel).toBe("56");
    expect(receipts).toEqual([]);
  },
);

/**
 * Each client's verdict on one URL, one line each: `ok` (the chain verified), `untrusted <why>`
 * (certificate verification failed) or `error <why>` (anything else: a timeout, a reset), so a
 * slow network never reads as a trust failure.
 */
const PYTHON_VERDICT = `import ssl, sys, urllib.error, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=15).close(); print("ok")
except urllib.error.HTTPError:
    print("ok")
except Exception as e:
    reason = getattr(e, "reason", e)
    print("untrusted" if isinstance(reason, ssl.SSLCertVerificationError) else "error", reason)`;
const NODE_VERDICT = `fetch(process.argv[1]).then(() => console.log("ok"), (e) => {
  const code = String(e.cause?.code ?? e.message);
  console.log(/CERT|ISSUER|SELF_SIGNED/.test(code) ? "untrusted" : "error", code);
})`;
const verdicts = (url: string, i: number, node: string) =>
  [
    // curl exits 60 when it cannot verify the peer's certificate
    `/usr/bin/curl --silent --output /dev/null --max-time 15 '${url}'; c=$?; case $c in 0) printf 'curl${i}:ok\\n';; 60) printf 'curl${i}:untrusted 60\\n';; *) printf 'curl${i}:error %s\\n' "$c";; esac`,
    `printf 'python${i}:%s\\n' "$(/usr/bin/python3 -I -c '${PYTHON_VERDICT.replaceAll("'", "'\\''")}' '${url}')"`,
    `printf 'node${i}:%s\\n' "$(NODE_USE_ENV_PROXY=1 '${node}' -e '${NODE_VERDICT}' '${url}')"`,
  ].join("; ");

// TLS trust inside the sandbox (R3 Mac acceptance): Apple's LibreSSL in /usr/bin/curl and the
// Command Line Tools' python3 checks a server chain against /etc/ssl/cert.pem first and, when that
// stale bundle lacks the anchor, asks the per-user TrustEvaluationAgent (the system keychain's
// roots and the admin's trust settings). Without that one Mach service a site anchored at a newer
// root (example.com's SSL.com 2022 chain) fails with "unable to get local issuer certificate".
// Node's fetch carries its own CA store; it is checked for the same result.
it.runIf(darwin)(
  "a restricted HTTPS fetch trusts what the system trusts (curl, python3, node)",
  async (context) => {
    if (!internet) context.skip("no internet: https://1.1.1.1 is unreachable from this process");
    const sites = ["https://example.com/", "https://github.com/"];
    const result = await run(sites.map((url, i) => verdicts(url, i, process.execPath)).join("; "), {
      readRoots: [dirname(dirname(process.execPath))],
    });
    const seen = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]),
    );
    sites.forEach((url, i) => {
      const of = (client: string) => String(seen[`${client}${i}`]);
      for (const client of ["curl", "python", "node"])
        expect(of(client), `${url}: ${result.stdout}${result.stderr}`).not.toMatch(/^untrusted/);
      // the site was reached and verified by at least one client (a network error is not proof)
      expect(
        ["curl", "python", "node"].some((c) => of(c) === "ok"),
        `${url}: ${result.stdout}`,
      ).toBe(true);
    });
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
    expect(readFileSync(join(dotfiles, "zshrc"), "utf8")).toBe("# rc\n");
  },
);

it.runIf(darwin)(
  "a protected location behind a two-hop link chain keeps every hop in place",
  async () => {
    const home = await mkdtemp(join(root, "home-"));
    const code = await mkdtemp(join(root, "code-"));
    await mkdir(join(code, "dotfiles-v1", "config", "systemd", "user"), { recursive: true });
    await writeFile(join(code, "dotfiles-v1", "zshrc"), "# rc\n");
    // ~/.zshrc -> code/dotfiles-current/zshrc and ~/.config -> code/dotfiles-current/config,
    // where dotfiles-current is itself a link inside the write root
    await symlink(join(code, "dotfiles-v1"), join(code, "dotfiles-current"));
    await symlink(join(code, "dotfiles-current", "zshrc"), join(home, ".zshrc"));
    await symlink(join(code, "dotfiles-current", "config"), join(home, ".config"));
    const result = await run(
      [
        `cd ${code}`,
        // swap the middle hop for a real directory holding a new rc file and a unit
        "rm dotfiles-current || mv dotfiles-current gone",
        "mkdir -p dotfiles-current/config/systemd/user",
        "printf evil > dotfiles-current/zshrc",
        "printf evil > dotfiles-current/config/systemd/user/evil.service",
        "ln -sfn /tmp dotfiles-current",
        "printf ok > plain",
        "true",
      ].join("; "),
      { readRoots: [code], writeRoots: [code] },
      { home },
    );
    expect(existsSync(join(code, "plain")), result.stderr).toBe(true);
    expect(lstatSync(join(code, "dotfiles-current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(code, "dotfiles-current"))).toBe(join(code, "dotfiles-v1"));
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# rc\n");
    expect(existsSync(join(home, ".config", "systemd", "user", "evil.service"))).toBe(false);
  },
);

it.runIf(darwin)(
  "an ancestor of a protected target cannot move away, in one call or across two",
  async () => {
    const home = await mkdtemp(join(root, "home-"));
    const code = await mkdtemp(join(root, "code-"));
    await mkdir(join(code, "dots", "v1"), { recursive: true });
    await writeFile(join(code, "dots", "v1", "zshrc"), "# rc\n");
    await symlink(join(code, "dots", "v1", "zshrc"), join(home, ".zshrc"));
    const grant = { readRoots: [code], writeRoots: [code] };
    // one call: move the target's ancestor away, recreate it, write the rc file
    const first = await run(
      `cd ${code}; mv dots moved; mkdir -p dots/v1; printf evil > dots/v1/zshrc; printf ok > plain; true`,
      grant,
      { home },
    );
    expect(existsSync(join(code, "plain")), first.stderr).toBe(true);
    expect(existsSync(join(code, "moved"))).toBe(false);
    // two calls: the second resolves the chain afresh and still finds the same target
    await run(`cd ${code}; mv dots/v1 dots/v0; true`, grant, { home });
    await run(`cd ${code}; mkdir -p dots/v1; printf evil > dots/v1/zshrc; true`, grant, { home });
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# rc\n");
    expect(existsSync(join(code, "dots", "v0"))).toBe(false);
  },
);

it.runIf(darwin)("an ancestor of a link in a protected chain cannot move away", async () => {
  const home = await mkdtemp(join(root, "home-"));
  const code = await mkdtemp(join(root, "code-"));
  await mkdir(join(code, "v1"), { recursive: true });
  await mkdir(join(code, "sub"), { recursive: true });
  await writeFile(join(code, "v1", "zshrc"), "# rc\n");
  // ~/.zshrc -> code/sub/current/zshrc, where code/sub/current -> code/v1
  await symlink(join(code, "v1"), join(code, "sub", "current"));
  await symlink(join(code, "sub", "current", "zshrc"), join(home, ".zshrc"));
  const result = await run(
    `cd ${code}; mv sub sub2; mkdir -p sub/current; printf evil > sub/current/zshrc; printf ok > plain; true`,
    { readRoots: [code], writeRoots: [code] },
    { home },
  );
  expect(existsSync(join(code, "plain")), result.stderr).toBe(true);
  expect(existsSync(join(code, "sub2"))).toBe(false);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# rc\n");
});

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
