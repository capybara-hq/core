import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPEN_PUBLIC_DENIED_CIDRS, SANDBOX_SYSTEM_WRITE_DENIES } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  escalatedEnvironment,
  MAC_DOH_ENDPOINTS,
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

/** One DNS-over-HTTPS request as the guard's seam sees it: the URL and the time it may take. */
type DohRequest = (url: string, timeoutMs: number) => Promise<unknown>;
/** The default seam of these tests: no DNS-over-HTTPS service is reachable. */
const noDoh: DohRequest = async () => {
  throw new Error("no DNS-over-HTTPS in this test");
};

/**
 * A guard configured as the macOS worker's network (open unless `openNetwork` is false), resolving
 * names through `answers` and DNS-over-HTTPS through `dohRequest`.
 */
async function openGuard(
  answers: Record<string, string[]>,
  localAddresses: string[] = [],
  dohRequest: DohRequest = noDoh,
  openNetwork = true,
) {
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
    ...macNetworkConfig({ hosts: [], openNetwork }).network,
    resolve,
    localAddresses: () => localAddresses,
    dohRequest,
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

// A fake-IP resolver (an OpenClash-style router intercepting every DNS query) answers each name
// with an address in 198.18.0.0/15: the guard re-resolves such a name through DNS-over-HTTPS to
// IP-literal endpoints and judges the real answer like any resolved address.
describe("the guard's DNS-over-HTTPS fallback for a fake-IP resolver", () => {
  /** A DoH JSON answer (the Cloudflare / Google format) per query type. */
  const json = (records: Record<"A" | "AAAA", string[]>, ttl = 60) => {
    const calls: string[] = [];
    const request: DohRequest = async (url) => {
      calls.push(url);
      const query = new URL(url);
      const type = query.searchParams.get("type") as "A" | "AAAA";
      return {
        Status: 0,
        Answer: [
          { name: query.searchParams.get("name"), type: 5, TTL: ttl, data: "alias.example." },
          ...records[type].map((data) => ({
            name: "alias.example.",
            type: type === "A" ? 1 : 28,
            TTL: ttl,
            data,
          })),
        ],
      };
    };
    return { calls, request };
  };

  it("re-resolves a fake-IP answer through DNS-over-HTTPS and dials the real address", async () => {
    const doh = json({ A: ["93.184.215.14"], AAAA: [] });
    const guard = await openGuard({ "site.test": ["198.18.0.9"] }, [], doh.request);
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    // A and AAAA from the first endpoint, an IP literal over HTTPS
    expect(doh.calls.map((u) => new URL(u).searchParams.get("type")).sort()).toEqual(["A", "AAAA"]);
    for (const url of doh.calls) expect(url).toMatch(/^https:\/\/1\.1\.1\.1\/dns-query\?/);
    expect(new URL(doh.calls[0] as string).searchParams.get("name")).toBe("site.test");
  });

  it("refuses a DNS-over-HTTPS answer in a closed class, or this host's own address", async () => {
    const doh = json({ A: ["10.0.0.5"], AAAA: ["fd12::5"] });
    const guard = await openGuard({ "intranet.test": ["198.18.0.3"] }, [], doh.request);
    expect(await dial(guard, "intranet.test")).toMatch(/^refused: resolved to/);
    const own = await openGuard(
      { "self.test": ["198.18.0.4"] },
      ["93.184.215.20"],
      json({ A: ["93.184.215.20"], AAAA: [] }).request,
    );
    expect(await dial(own, "self.test")).toMatch(/^refused: resolved to/);
  });

  it("refuses, naming the fake-IP resolver, when DNS-over-HTTPS fails; never the fake address", async () => {
    const guard = await openGuard({ "site.test": ["198.18.0.9", "198.18.0.10"] });
    const answer = await dial(guard, "site.test");
    expect(answer).toMatch(/^refused: .*fake-IP resolver/);
    expect(answer).toContain("DNS-over-HTTPS");
  });

  it("falls back to the next endpoint", async () => {
    const good = json({ A: ["93.184.215.14"], AAAA: [] });
    const tried: string[] = [];
    const guard = await openGuard({ "site.test": ["198.18.0.9"] }, [], async (url, timeoutMs) => {
      tried.push(new URL(url).host);
      expect(timeoutMs).toBeGreaterThan(0);
      if (new URL(url).host === "1.1.1.1") throw new Error("timeout");
      return good.request(url, timeoutMs);
    });
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(tried).toContain("1.0.0.1");
  });

  it("caches an answer for its TTL", async () => {
    const doh = json({ A: ["93.184.215.14"], AAAA: [] });
    const guard = await openGuard({ "site.test": ["198.18.0.9"] }, [], doh.request);
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(doh.calls).toHaveLength(2);
  });

  it("leaves a name the system resolver answers without a fake-IP address alone", async () => {
    const doh = json({ A: ["10.0.0.1"], AAAA: [] });
    const guard = await openGuard({ "site.test": ["93.184.215.14"] }, [], doh.request);
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(doh.calls).toEqual([]);
  });

  it("also serves an allow-listed name in the allowlist network", async () => {
    const doh = json({ A: ["93.184.215.14"], AAAA: [] });
    const guard = await openGuard({ "granted.test": ["198.18.0.9"] }, [], doh.request, false);
    expect(await dial(guard, "granted.test")).toBe("93.184.215.14");
  });

  it("refuses an endpoint that is not an HTTPS IP literal", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    for (const endpoint of ["https://dns.google/resolve", "http://1.1.1.1/dns-query"])
      expect(() => createResolvedAddressGuard({ fakeIpDoh: { endpoints: [endpoint] } })).toThrow(
        /DNS-over-HTTPS endpoint/,
      );
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
        fakeIpDoh: { endpoints: [...MAC_DOH_ENDPOINTS] },
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
      network: {
        allowedDomains: ["a.example.com"],
        deniedDomains: [],
        fakeIpDoh: { endpoints: [...MAC_DOH_ENDPOINTS] },
        allowLocalBinding: false,
      },
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
