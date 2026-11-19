import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPEN_PUBLIC_DENIED_CIDRS,
  SANDBOX_FAKE_IP_DNS,
  SANDBOX_SYSTEM_WRITE_DENIES,
} from "@capybara-hq/plugin-sdk";
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

/** One DNS-over-HTTPS request as the guard's seam sees it: the URL and the time it may take. */
type DohRequest = (url: string, timeoutMs: number) => Promise<Buffer>;
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
    const source = readFileSync(join(srt, "dist/sandbox/sandbox-manager.js"), "utf8");
    const filter = source.slice(source.indexOf("async function filterNetworkRequest"));
    const literal = filter.indexOf("resolvedAddressGuard.literalDenial(canonicalHost, port)");
    expect(literal).toBeGreaterThan(0);
    expect(literal).toBeLessThan(filter.indexOf("// Check allowed domains"));
  });
});

/** A DNS wire-format query's name and type (RFC 1035), as the guard sends it. */
function parseQuery(query: Buffer): { name: string; type: number } {
  const labels: string[] = [];
  let at = 12;
  while (query[at]) {
    const length = query[at] as number;
    labels.push(query.subarray(at + 1, at + 1 + length).toString("ascii"));
    at += length + 1;
  }
  return { name: labels.join("."), type: query.readUInt16BE(at + 1) };
}

/** A wire-format answer to `query`: a CNAME, then each address (by name compression). */
function wireAnswer(query: Buffer, addresses: string[], ttl: number, rcode = 0): Buffer {
  const { type } = parseQuery(query);
  const question = query.subarray(12);
  const records: Buffer[] = [];
  const record = (rtype: number, rdata: Buffer) => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0xc00c, 0);
    head.writeUInt16BE(rtype, 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt32BE(ttl, 6);
    head.writeUInt16BE(rdata.length, 10);
    records.push(head, rdata);
  };
  record(5, Buffer.from([5, ...Buffer.from("alias"), 0xc0, 0x0c]));
  for (const address of addresses) {
    const v6 = address.includes(":");
    if ((type === 28) !== v6) continue;
    const bytes = v6
      ? Buffer.from(
          new URL(`http://[${address}]`).hostname
            .slice(1, -1)
            .split(":")
            .flatMap((group, i, all) =>
              group === ""
                ? i === 0 || i === all.length - 1
                  ? []
                  : Array(9 - all.length).fill("0")
                : [group],
            )
            .flatMap((group) => {
              const n = Number.parseInt(group || "0", 16);
              return [n >> 8, n & 0xff];
            }),
        )
      : Buffer.from(address.split(".").map(Number));
    record(type, bytes);
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length / 2, 6);
  return Buffer.concat([header, question, ...records]);
}

// A fake-IP resolver (an OpenClash-style router intercepting every DNS query) answers each name
// with an address in 198.18.0.0/15: the guard re-resolves such a name through DNS-over-HTTPS (RFC
// 8484, GET, wire format) to the SDK's IP-literal endpoints and judges the real answer like any
// resolved address.
describe("the guard's DNS-over-HTTPS fallback for a fake-IP resolver", () => {
  /** A DoH service answering `records` per type; records each request URL and its time share. */
  const service = (records: Record<"A" | "AAAA", string[]>, ttl = 60) => {
    const calls: { url: string; timeoutMs: number; name: string; type: number }[] = [];
    const request: DohRequest = async (url, timeoutMs) => {
      const query = Buffer.from(new URL(url).searchParams.get("dns") ?? "", "base64url");
      const { name, type } = parseQuery(query);
      calls.push({ url, timeoutMs, name, type });
      return wireAnswer(query, [...records.A, ...records.AAAA], ttl);
    };
    return { calls, request };
  };

  it("re-resolves a fake-IP answer through DNS-over-HTTPS and dials the real address", async () => {
    const doh = service({ A: ["93.184.215.14"], AAAA: [] });
    const guard = await openGuard({ "site.test": ["198.18.0.9"] }, [], doh.request);
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    // A and AAAA from the first SDK endpoint, RFC 8484 GET
    expect(doh.calls.map((c) => c.type).sort()).toEqual([1, 28]);
    for (const call of doh.calls) {
      expect(call.url.startsWith(`${SANDBOX_FAKE_IP_DNS.endpoints[0]}?dns=`)).toBe(true);
      expect(call.name).toBe("site.test");
    }
  });

  it("dials an IPv6 answer too", async () => {
    const doh = service({ A: [], AAAA: ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"] });
    const guard = await openGuard({ "v6.test": ["198.18.0.9"] }, [], doh.request);
    expect(await dial(guard, "v6.test")).toBe("2606:2800:21f:cb07:6820:80da:af6b:8b2c");
  });

  it("refuses a DNS-over-HTTPS answer in a closed class, or this host's own address", async () => {
    const doh = service({ A: ["10.0.0.5"], AAAA: ["fd12::5"] });
    const guard = await openGuard({ "intranet.test": ["198.18.0.3"] }, [], doh.request);
    expect(await dial(guard, "intranet.test")).toMatch(/^refused: resolved to/);
    const own = await openGuard(
      { "self.test": ["198.18.0.4"] },
      ["93.184.215.20"],
      service({ A: ["93.184.215.20"], AAAA: [] }).request,
    );
    expect(await dial(own, "self.test")).toMatch(/^refused: resolved to/);
  });

  it("refuses, naming the fake-IP resolver, when DNS-over-HTTPS fails; never the fake address", async () => {
    const guard = await openGuard({ "site.test": ["198.18.0.9", "198.18.0.10"] });
    const answer = await dial(guard, "site.test");
    expect(answer).toMatch(/^refused: .*fake-IP resolver/);
    expect(answer).toContain("DNS-over-HTTPS");
  });

  it("gives each endpoint a share of the deadline, so a stalled one leaves time for the next", async () => {
    const good = service({ A: ["93.184.215.14"], AAAA: [] });
    const shares: Record<string, number> = {};
    const guard = await openGuard({ "site.test": ["198.18.0.9"] }, [], (url, timeoutMs) => {
      const host = new URL(url).host;
      shares[host] = timeoutMs;
      // the first endpoint never answers: only its share of the deadline runs out
      if (host === "1.1.1.1") return new Promise(() => {});
      return good.request(url, timeoutMs);
    });
    const started = Date.now();
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    const { timeoutMs, endpoints } = SANDBOX_FAKE_IP_DNS;
    expect(shares["1.1.1.1"]).toBeLessThanOrEqual(Math.ceil(timeoutMs / endpoints.length));
    expect(shares["1.0.0.1"]).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(timeoutMs);
  });

  it("caches an answer for its TTL, only when both A and AAAA answered", async () => {
    const doh = service({ A: ["93.184.215.14"], AAAA: [] });
    const guard = await openGuard({ "site.test": ["198.18.0.9"] }, [], doh.request);
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(doh.calls).toHaveLength(2);
    // AAAA fails everywhere: the A answer is used, and asked again next time
    const partial = service({ A: ["93.184.215.14"], AAAA: [] });
    const flaky = await openGuard({ "site.test": ["198.18.0.9"] }, [], async (url, timeoutMs) => {
      const query = Buffer.from(new URL(url).searchParams.get("dns") ?? "", "base64url");
      if (parseQuery(query).type === 28) throw new Error("AAAA unavailable");
      return partial.request(url, timeoutMs);
    });
    expect(await dial(flaky, "site.test")).toBe("93.184.215.14");
    const before = partial.calls.length;
    expect(await dial(flaky, "site.test")).toBe("93.184.215.14");
    expect(partial.calls.length).toBeGreaterThan(before);
  });

  it("leaves a name the system resolver answers without a fake-IP address alone", async () => {
    const doh = service({ A: ["10.0.0.1"], AAAA: [] });
    const guard = await openGuard({ "site.test": ["93.184.215.14"] }, [], doh.request);
    expect(await dial(guard, "site.test")).toBe("93.184.215.14");
    expect(doh.calls).toEqual([]);
  });

  it("also serves an allow-listed name in the allowlist network", async () => {
    const doh = service({ A: ["93.184.215.14"], AAAA: [] });
    const guard = await openGuard({ "granted.test": ["198.18.0.9"] }, [], doh.request, false);
    expect(await dial(guard, "granted.test")).toBe("93.184.215.14");
  });

  it("refuses an endpoint that is not an HTTPS IP literal", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    for (const endpoint of ["https://dns.google/dns-query", "http://1.1.1.1/dns-query"])
      expect(() =>
        createResolvedAddressGuard({
          fakeIpDoh: { ...SANDBOX_FAKE_IP_DNS, endpoints: [endpoint] },
        }),
      ).toThrow(/DNS-over-HTTPS endpoint/);
  });
});

// The default DNS-over-HTTPS request against a local HTTPS server with a self-signed certificate
// for 127.0.0.1: refused as untrusted, and (trusting it through the test's `ca`) bounded in size
// and refused on a status other than 200.
describe("the guard's default DNS-over-HTTPS request", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function server(handler: (res: import("node:http").ServerResponse) => void) {
    const dir = await mkdtemp(join(tmpdir(), "cap-doh-cert-"));
    dirs.push(dir);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const { createServer } = await import("node:https");
    const https = createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (_req, res) =>
      handler(res),
    );
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    const address = https.address() as import("node:net").AddressInfo;
    return {
      url: `https://127.0.0.1:${address.port}/dns-query?dns=AAAB`,
      cert,
      close: () => new Promise<void>((r) => https.close(() => r())),
    };
  }

  it("rejects an untrusted certificate, a status other than 200 and an oversized answer", async () => {
    const { defaultDohRequest } = await load("resolved-address-guard.js");
    const ok = await server((res) => res.end(Buffer.from([1, 2, 3])));
    try {
      await expect(defaultDohRequest(ok.url, 2000)).rejects.toThrow(/self[- ]signed|certificate/i);
      expect(await defaultDohRequest(ok.url, 2000, { ca: ok.cert })).toEqual(
        Buffer.from([1, 2, 3]),
      );
    } finally {
      await ok.close();
    }
    const bad = await server((res) => {
      res.statusCode = 503;
      res.end("busy");
    });
    try {
      await expect(defaultDohRequest(bad.url, 2000, { ca: bad.cert })).rejects.toThrow(/503/);
    } finally {
      await bad.close();
    }
    const big = await server((res) => res.end(Buffer.alloc(70_000)));
    try {
      await expect(defaultDohRequest(big.url, 2000, { ca: big.cert })).rejects.toThrow(/too large/);
    } finally {
      await big.close();
    }
  });
});

describe("the macOS worker's network configuration", () => {
  const closed = {
    deniedResolvedAddresses: [...OPEN_PUBLIC_DENIED_CIDRS],
    resolvedAddressStrict: true,
  };
  const doh = {
    fakeIpDoh: { ...SANDBOX_FAKE_IP_DNS, endpoints: [...SANDBOX_FAKE_IP_DNS.endpoints] },
  };

  it("opens the network through the address guard only", async () => {
    const open = macNetworkConfig({ hosts: ["a.example.com"], openNetwork: true });
    expect(open).toEqual({
      askAll: true,
      network: {
        allowedDomains: [],
        deniedDomains: [],
        ...closed,
        ...doh,
        allowLocalBinding: false,
      },
    });
    // the runtime's own schema accepts every closed range and the DNS settings as written
    const { NetworkConfigSchema } = await load("sandbox-config.js");
    expect(NetworkConfigSchema.parse(open.network)).toMatchObject(open.network);
  });

  it("closes the same address classes in the allowlist network", async () => {
    const allowlist = macNetworkConfig({ hosts: ["a.example.com"] });
    expect(allowlist).toEqual({
      askAll: false,
      network: {
        allowedDomains: ["a.example.com"],
        deniedDomains: [],
        ...closed,
        ...doh,
        allowLocalBinding: false,
      },
    });
    const { NetworkConfigSchema } = await load("sandbox-config.js");
    expect(NetworkConfigSchema.parse(allowlist.network)).toMatchObject(allowlist.network);
  });

  it("lifts the address rules only through the trusted test seam", () => {
    const seam = macNetworkConfig({ hosts: ["127.0.0.1:8080"] }, { allowPrivate: true });
    expect(seam.network).not.toHaveProperty("deniedResolvedAddresses");
    expect(seam.network).not.toHaveProperty("resolvedAddressStrict");
  });

  it("refuses an allow-listed private literal or name in strict mode", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    const guard = createResolvedAddressGuard({
      ...macNetworkConfig({ hosts: ["10.0.0.5", "127.0.0.1:8080", "intranet.test"] }).network,
      resolve: ((_h, _o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }])) as Lookup,
      dohRequest: noDoh,
    }) as Guard;
    expect(guard.literalDenial("10.0.0.5", 80)).toBeTypeOf("string");
    expect(guard.literalDenial("127.0.0.1", 8080)).toBeTypeOf("string");
    expect(await dial(guard, "intranet.test")).toMatch(/^refused: resolved to/);
  });
});

describe("the macOS worker's protected write denies", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const lower = (paths: string[]) => paths.map((p) => p.toLowerCase());

  it("adds the system paths, every link met on the way, and the final targets", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-protected-")));
    dirs.push(root);
    const home = join(root, "home");
    const code = join(root, "code");
    await mkdir(join(home, ".local", "share"), { recursive: true });
    await mkdir(join(code, "dotfiles-v1", "config"), { recursive: true });
    await mkdir(join(code, "agents"));
    await writeFile(join(code, "dotfiles-v1", "zshrc"), "");
    // two hops: ~/.zshrc -> code/dotfiles-current/zshrc, dotfiles-current -> dotfiles-v1
    await symlink(join(code, "dotfiles-v1"), join(code, "dotfiles-current"));
    await symlink(join(code, "dotfiles-current", "zshrc"), join(home, ".zshrc"));
    await symlink(join(code, "dotfiles-current", "config"), join(home, ".config"));
    // a relative link and a dangling one
    await symlink("../code/agents", join(home, ".vscode"));
    await symlink(join(code, "missing-bashrc"), join(home, ".bashrc"));
    const { subtrees, links } = macProtectedWriteDenies(home);
    for (const path of SANDBOX_SYSTEM_WRITE_DENIES) expect(subtrees).toContain(path);
    if (process.platform === "darwin") expect(subtrees).toContain("/private/var/at");
    expect(subtrees).toContain(join(code, "dotfiles-v1", "zshrc"));
    expect(subtrees).toContain(join(code, "dotfiles-v1", "config", "systemd"));
    expect(subtrees).toContain(join(code, "dotfiles-v1", "config", "git", "config"));
    expect(subtrees).toContain(join(code, "agents"));
    expect(subtrees).toContain(join(code, "missing-bashrc"));
    // the links themselves: the middle hop cannot be removed or replaced
    for (const link of [".zshrc", ".config", ".vscode", ".bashrc"])
      expect(lower(links)).toContain(join(home, link).toLowerCase());
    expect(links).toContain(join(code, "dotfiles-current"));
    // links are exact denies, never subtrees; nothing unlinked under home is listed
    expect(subtrees.some((d) => d.startsWith(`${home}/`))).toBe(false);
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
