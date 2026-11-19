import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPEN_PUBLIC_DENIED_CIDRS, SANDBOX_SYSTEM_WRITE_DENIES } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  escalatedEnvironment,
  macNetworkConfig,
  macProtectedWriteDenies,
} from "../src/exec/operation-worker.js";

// The open network's decisions (approval-only profiles design, "Open network") in the patched
// sandbox runtime and the macOS worker's configuration, without the OS: the real-Seatbelt runs are
// in mac-open-network.test.ts. The runtime patch (`patches/@anthropic-ai__sandbox-runtime@0.0.81
// .patch`, `resolvedAddressStrict`) is pinned to srt 0.0.81.
const require = createRequire(import.meta.url);
const srt = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
const load = async (file: string) => import(pathToFileURL(join(srt, "dist/sandbox", file)).href);

type Lookup = (
  host: string,
  options: unknown,
  callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
) => void;
interface Guard {
  lookupFor(
    port: number,
  ): (
    host: string,
    options: { all?: boolean },
    callback: (error: (Error & { reason?: string }) | null, address?: unknown) => void,
  ) => void;
  literalDenial(address: string, port: number): string | undefined;
}

/** A guard configured as the macOS worker's open network, resolving names through `answers`. */
async function openGuard(answers: Record<string, string[]>, localAddresses: string[] = []) {
  const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
  const resolve: Lookup = (host, _options, callback) => {
    const list = answers[host];
    if (!list) callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    else
      callback(
        null,
        list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
  };
  return createResolvedAddressGuard({
    ...macNetworkConfig({ hosts: [], openNetwork: true }).network,
    resolve,
    localAddresses: () => localAddresses,
  }) as Guard;
}

/** Whether the guard lets `host` be dialed on port 443 (the address it dials, or the refusal). */
function dial(guard: Guard, host: string): Promise<string> {
  return new Promise((resolve) => {
    guard.lookupFor(443)(host, {}, (error, address) =>
      resolve(error ? `refused: ${error.reason ?? error.message}` : String(address)),
    );
  });
}

describe("the patched runtime's strict resolved-address guard", () => {
  it("dials a name resolving to a public address, and refuses one rebound to a closed class", async () => {
    const guard = await openGuard({
      "public.test": ["93.184.215.14"],
      "private.test": ["10.0.0.1"],
      "lan.test": ["192.168.1.1"],
      "cgnat.test": ["100.64.0.1"],
      "ula.test": ["fd12::1"],
      "metadata.test": ["169.254.169.254"],
      "azure.test": ["168.63.129.16"],
      "loopback.test": ["127.0.0.1"],
      "nat64.test": ["64:ff9b::5db8:d70e"],
      "fake-ip.test": ["198.18.0.7"],
      // a mixed answer: the closed address is dropped, the public one dialed
      "mixed.test": ["10.0.0.1", "93.184.215.14"],
    });
    expect(await dial(guard, "public.test")).toBe("93.184.215.14");
    expect(await dial(guard, "mixed.test")).toBe("93.184.215.14");
    for (const host of [
      "private.test",
      "lan.test",
      "cgnat.test",
      "ula.test",
      "metadata.test",
      "azure.test",
      "loopback.test",
      "nat64.test",
      "fake-ip.test",
    ])
      expect(await dial(guard, host), host).toMatch(/^refused: resolved to/);
  });

  it("gives localhost no loopback carve-out", async () => {
    const guard = await openGuard({ localhost: ["127.0.0.1", "::1"] });
    expect(await dial(guard, "localhost")).toMatch(/^refused/);
    // upstream behaviour without the strict mode: localhost may resolve to loopback
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    const lax = createResolvedAddressGuard({
      resolve: ((_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as Lookup,
    }) as Guard;
    expect(await dial(lax, "localhost")).toBe("127.0.0.1");
  });

  it("judges an IP literal by the same classes, this host's addresses included", async () => {
    const guard = await openGuard({}, ["203.0.114.9"]);
    for (const literal of [
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "fd12::1",
      "fe80::1",
      "169.254.169.254",
      "168.63.129.16",
      "fd00:ec2::254",
      "127.0.0.1",
      "::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "0.0.0.0",
      "224.0.0.1",
      "203.0.114.9",
    ])
      expect(guard.literalDenial(literal, 80), literal).toBeTypeOf("string");
    expect(guard.literalDenial("1.1.1.1", 443)).toBeUndefined();
    expect(guard.literalDenial("2606:4700:4700::1111", 443)).toBeUndefined();
  });

  it("leaves literals to upstream without the strict mode", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    const lax = createResolvedAddressGuard({}) as Guard;
    expect(lax.literalDenial("10.0.0.1", 80)).toBeUndefined();
  });

  it("checks a literal in the proxy's request filter before any allow rule", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(srt, "dist/sandbox/sandbox-manager.js"), "utf8");
    const filter = source.slice(source.indexOf("async function filterNetworkRequest"));
    const literal = filter.indexOf("resolvedAddressGuard.literalDenial(canonicalHost, port)");
    expect(literal).toBeGreaterThan(0);
    expect(literal).toBeLessThan(filter.indexOf("// Check allowed domains"));
  });
});

describe("the macOS worker's network configuration", () => {
  it("opens the network through the address guard only", async () => {
    const open = macNetworkConfig({ hosts: ["a.example.com"], openNetwork: true });
    expect(open).toEqual({
      askAll: true,
      network: {
        allowedDomains: [],
        deniedDomains: [],
        deniedResolvedAddresses: [...OPEN_PUBLIC_DENIED_CIDRS],
        resolvedAddressStrict: true,
        allowLocalBinding: false,
      },
    });
    // the runtime's own schema accepts every closed range as written
    const { NetworkConfigSchema } = await load("sandbox-config.js");
    expect(NetworkConfigSchema.parse(open.network)).toMatchObject(open.network);
  });

  it("keeps the allowlist as before", () => {
    expect(macNetworkConfig({ hosts: ["a.example.com"] })).toEqual({
      askAll: false,
      network: { allowedDomains: ["a.example.com"], deniedDomains: [], allowLocalBinding: false },
    });
  });
});

describe("the macOS worker's protected write denies", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("adds the system paths and the resolved targets of linked home locations", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-protected-")));
    dirs.push(root);
    const home = join(root, "home");
    const dotfiles = join(root, "dotfiles");
    await mkdir(join(home, "Library"), { recursive: true });
    await mkdir(join(dotfiles, "config"), { recursive: true });
    await mkdir(join(dotfiles, "agents"));
    await mkdir(join(home, ".local", "share"), { recursive: true });
    await symlink(join(dotfiles, "config"), join(home, ".config"));
    await symlink(join(dotfiles, "agents"), join(home, "Library", "LaunchAgents"));
    await symlink(join(dotfiles, "zshrc"), join(home, ".zshrc"));
    const denies = macProtectedWriteDenies(home);
    for (const path of SANDBOX_SYSTEM_WRITE_DENIES) expect(denies).toContain(path);
    if (process.platform === "darwin") expect(denies).toContain("/private/var/at");
    // a link's target, also below a linked directory and where the entry does not exist yet
    expect(denies).toContain(join(dotfiles, "agents"));
    expect(denies).toContain(join(dotfiles, "zshrc"));
    expect(denies).toContain(join(dotfiles, "config", "systemd"));
    expect(denies).toContain(join(dotfiles, "config", "autostart"));
    expect(denies).toContain(join(dotfiles, "config", "git", "config"));
    // an unlinked location needs no absolute deny: the per-root policy names it
    expect(denies.some((d) => d.startsWith(`${home}/`))).toBe(false);
  });
});

describe("the escalated call's environment", () => {
  it("drops every CAPYBARA_ variable and keeps the rest, the call's own last", () => {
    expect(
      escalatedEnvironment(
        { PATH: "/bin", CAPYBARA_DEVICE_DIR: "/s", capybara_token: "t", AWS_PROFILE: "p" },
        { EXTRA: "1", PATH: "/usr/bin" },
      ),
    ).toEqual({ PATH: "/usr/bin", AWS_PROFILE: "p", EXTRA: "1" });
  });
});
