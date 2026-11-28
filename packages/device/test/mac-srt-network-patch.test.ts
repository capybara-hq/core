import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPEN_PUBLIC_DENIED_CIDRS,
  SANDBOX_FAKE_IP_DNS,
  SANDBOX_SYSTEM_WRITE_DENIES,
} from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** Whether the guard lets `host` be dialed on `port` (the address it dials, or the refusal). */
function dial(guard: Guard, host: string, port = 443): Promise<string> {
  return new Promise((resolve) => {
    guard.lookupFor(port)(host, {}, (error, address) =>
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

/** A resolver answering every name with `addresses`. */
const answer =
  (...addresses: string[]): Lookup =>
  (_host, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );

/** The macOS worker's strict open network, with no DNS-over-HTTPS and no local addresses. */
const STRICT = {
  ...macNetworkConfig({ hosts: [], openNetwork: true }).network,
  dohRequest: noDoh,
  localAddresses: () => [],
};

/** The addresses the guard's lookup for `port` hands the dialer for `host` (`all: true`). */
function lookup(guard: Guard, host: string, port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    guard.lookupFor(port)(host, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });
}

type FilterNetworkRequest = (
  port: number,
  host: string,
  ask: undefined,
  encodedCommand: undefined,
  explain: (reason: string) => void,
) => Promise<boolean>;

type FilterAnswer = { allowed: true } | { allowed: false; reason: string | undefined };

/**
 * The patched runtime's proxy request filter (`filterNetworkRequest`, module-private) evaluated
 * from its source against the macOS worker's allowlist network (no hosts, no ask callback) plus
 * `network`, with the runtime's own host helpers and a guard built from the same config.
 */
async function patchedFilter(
  network: Record<string, unknown>,
  base: Record<string, unknown> = macNetworkConfig({ hosts: [] }).network,
): Promise<{ filterNetworkRequest: FilterNetworkRequest; guard: Guard }> {
  const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
  const { canonicalizeHost, isValidHost } = await load("parent-proxy.js");
  const { matchesDomainPatternWithPort } = await load("domain-pattern.js");
  const { isIP } = await import("node:net");
  const config = { network: { ...base, ...network } };
  const guard = createResolvedAddressGuard({
    ...config.network,
    resolve: answer(),
    dohRequest: noDoh,
    localAddresses: () => [],
  });
  const source = readFileSync(join(srt, "dist/sandbox/sandbox-manager.js"), "utf8");
  const start = source.indexOf("async function filterNetworkRequest");
  const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
  const deps = {
    config,
    resolvedAddressGuard: guard,
    canonicalizeHost,
    isValidHost,
    matchesDomainPatternWithPort,
    isIP,
    logForDebugging: () => {},
    recordOutboundDeny: () => {},
    deniedDomainReason: () => "host is on the deny list",
    commandNetworkListsByKey: new Map(),
    decodeSandboxedCommand: (key: string) => key,
    isDeclaredDenial: () => true,
    denialReasonOf: () => undefined,
  };
  const filterNetworkRequest = new Function(
    ...Object.keys(deps),
    `${body}\nreturn filterNetworkRequest;`,
  )(...Object.values(deps));
  return { filterNetworkRequest, guard: guard as Guard };
}

/** {@link patchedFilter} answering whether `host:port` is allowed, and the refusal's reason. */
async function strictFilter(
  network: Record<string, unknown>,
  base?: Record<string, unknown>,
): Promise<(port: number, host: string) => Promise<FilterAnswer>> {
  const { filterNetworkRequest } = await patchedFilter(network, base);
  return async (port, host) => {
    let reason: string | undefined;
    const allowed = await filterNetworkRequest(port, host, undefined, undefined, (r: string) => {
      reason = r;
    });
    return allowed ? { allowed: true } : { allowed: false, reason };
  };
}

// A granted local port (browser loopback port grants design): in strict mode the proxy dials
// exactly the addresses 127.0.0.1 and ::1 and the name localhost (never resolved), each after the
// runtime's host canonicalization, on a listed port, and nothing else a strict network closes
// opens with it.
describe("the patched runtime's exact loopback carve-out", () => {
  it("allows exactly 127.0.0.1, [::1] and localhost on a listed port", async () => {
    const filter = await strictFilter({ allowedLoopbackPorts: [3999] });
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"])
      expect(await filter(3999, host), host).toEqual({ allowed: true });
  });

  it("matches the address after canonicalization, not the spelling", async () => {
    const filter = await strictFilter({ allowedLoopbackPorts: [3999] });
    // other spellings of the same three destinations (the proxies dial the canonical form)
    for (const host of [
      "127.1",
      "0x7f000001",
      "2130706433",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
      "0:0:0:0:0:0:0:1",
      "localhost.",
      "LocalHost.",
    ])
      expect(await filter(3999, host), host).toEqual({ allowed: true });
    for (const host of ["127.0.0.2", "127.1.0.1", "0.0.0.0", "localhost..", "::ffff:127.0.0.2"])
      expect((await filter(3999, host)).allowed, host).toBe(false);
  });

  it("refuses another port, another loopback literal, a private literal and metadata", async () => {
    const filter = await strictFilter({ allowedLoopbackPorts: [3999] });
    expect(await filter(4000, "127.0.0.1")).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/^address is /),
    });
    expect((await filter(4000, "localhost")).allowed).toBe(false);
    for (const host of [
      "127.0.0.2",
      "10.0.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
      "fe80::1",
      "0.0.0.0",
      "::",
      "app.localhost",
      "localhost.example.test",
    ])
      expect((await filter(3999, host)).allowed, host).toBe(false);
  });

  it("keeps a deny-listed loopback entry refused", async () => {
    const filter = await strictFilter({
      allowedLoopbackPorts: [3999],
      deniedDomains: ["127.0.0.1:3999", "localhost"],
    });
    expect((await filter(3999, "127.0.0.1")).allowed).toBe(false);
    expect((await filter(3999, "localhost")).allowed).toBe(false);
    expect(await filter(3999, "::1")).toEqual({ allowed: true });
  });

  it("refuses a name that resolves to 127.0.0.1", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    const guard = createResolvedAddressGuard({
      ...STRICT,
      allowedLoopbackPorts: [3999],
      resolve: answer("127.0.0.1"),
    }) as Guard;
    expect(await dial(guard, "dev.example.test", 3999)).toMatch(/^refused: resolved to/);
    expect(await dial(guard, "app.localhost", 3999)).toMatch(/^refused: resolved to/);
  });

  it("dials localhost without the resolver, and only on a listed port", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    const resolve = vi.fn(answer("127.0.0.1"));
    const guard = createResolvedAddressGuard({
      ...STRICT,
      allowedLoopbackPorts: [3999],
      resolve,
    }) as Guard & { loopbackCarveOut(hostname: string, port: number): string | undefined };
    // both loopback literals, IPv4 first: net's autoSelectFamily moves on when one refuses
    const both = [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ];
    expect(await lookup(guard, "localhost", 3999)).toEqual(both);
    expect(await lookup(guard, "LocalHost", 3999)).toEqual(both);
    expect(await dial(guard, "localhost", 3999)).toBe("127.0.0.1");
    expect(resolve).not.toHaveBeenCalled();
    expect(guard.loopbackCarveOut("127.0.0.1", 3999)).toBe("127.0.0.1");
    expect(guard.loopbackCarveOut("::1", 3999)).toBe("::1");
    expect(guard.loopbackCarveOut("localhost", 3999)).toBe("127.0.0.1");
    expect(guard.loopbackCarveOut("localhost", 4000)).toBeUndefined();
    expect(guard.loopbackCarveOut("127.0.0.2", 3999)).toBeUndefined();
    // another port goes through the resolver and is refused as today
    expect(await dial(guard, "localhost", 4000)).toMatch(/^refused: resolved to/);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("ignores allowedLoopbackPorts without strict mode", async () => {
    const { createResolvedAddressGuard } = await load("resolved-address-guard.js");
    const resolve = vi.fn(answer("127.0.0.1"));
    const lax = createResolvedAddressGuard({ allowedLoopbackPorts: [3999], resolve }) as Guard & {
      loopbackCarveOut(hostname: string, port: number): string | undefined;
    };
    expect(lax.loopbackCarveOut("127.0.0.1", 3999)).toBeUndefined();
    // upstream: localhost is resolved and may resolve to loopback
    expect(await dial(lax, "localhost", 3999)).toBe("127.0.0.1");
    expect(resolve).toHaveBeenCalledTimes(1);
    const filter = await strictFilter(
      { allowedLoopbackPorts: [3999] },
      { allowedDomains: [], deniedDomains: [] },
    );
    expect(await filter(3999, "127.0.0.1")).toEqual({
      allowed: false,
      reason: "host is not on the allow list",
    });
  });

  it("checks the carve-out after the deny list and before the literal check", () => {
    const source = readFileSync(join(srt, "dist/sandbox/sandbox-manager.js"), "utf8");
    const filter = source.slice(source.indexOf("async function filterNetworkRequest"));
    const carveOut = filter.indexOf("resolvedAddressGuard.loopbackCarveOut(canonicalHost, port)");
    expect(carveOut).toBeGreaterThan(filter.indexOf("// Check denied domains first"));
    expect(carveOut).toBeLessThan(
      filter.indexOf("resolvedAddressGuard.literalDenial(canonicalHost, port)"),
    );
  });

  it("accepts the option in the network config schema", async () => {
    const { NetworkConfigSchema } = await load("sandbox-config.js");
    const BASE = macNetworkConfig({ hosts: [] }).network;
    expect(NetworkConfigSchema.safeParse({ ...BASE, allowedLoopbackPorts: [3999] }).success).toBe(
      true,
    );
    for (const ports of [[0], [65536], [1.5], Array.from({ length: 33 }, (_, i) => 3000 + i)])
      expect(NetworkConfigSchema.safeParse({ ...BASE, allowedLoopbackPorts: ports }).success).toBe(
        false,
      );
  });
});

/** Whether this host has the IPv6 loopback address (some CI containers have no IPv6). */
const hasIpv6Loopback = Object.values(networkInterfaces())
  .flat()
  .some((i) => i?.address === "::1");

/** An HTTP server on `host` (port 0, or `port`) answering every request with `tag`. */
async function listener(host: string, tag: string, port = 0) {
  const server = createHttpServer((_req, res) => res.end(tag));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * The patched runtime's real HTTP proxy (`createHttpProxyServer`) on 127.0.0.1, filtering with the
 * patched `filterNetworkRequest` and dialing through the guard's lookup, as `sandbox-manager.js`
 * wires them, for the macOS worker's strict allowlist network plus `network`.
 */
async function patchedProxy(network: Record<string, unknown>) {
  const { createHttpProxyServer } = await load("http-proxy.js");
  const { filterNetworkRequest, guard } = await patchedFilter(network);
  const server = createHttpProxyServer({
    filter: (
      port: number,
      host: string,
      _socket: unknown,
      _command: unknown,
      explain: (r: string) => void,
    ) => filterNetworkRequest(port, host, undefined, undefined, explain),
    lookupFor: (port: number) => guard.lookupFor(port),
  }) as import("node:http").Server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (server.address() as AddressInfo).port;

  /** CONNECT `authority`, then GET / through the tunnel: the status, and the body when 200. */
  const connect = (authority: string) =>
    new Promise<{ status: number; body?: string }>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: authority,
        agent: false,
      });
      req.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0 });
          return;
        }
        const chunks: Buffer[] = [];
        socket.on("data", (c: Buffer) => chunks.push(c));
        socket.on("error", reject);
        socket.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: 200, body: text.slice(text.indexOf("\r\n\r\n") + 4) });
        });
        socket.write("GET / HTTP/1.1\r\nHost: granted\r\nConnection: close\r\n\r\n");
      });
      req.on("error", reject);
      req.end();
    });

  /** An absolute-form GET for `url` through the proxy: the status and the body. */
  const get = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: url,
          agent: false,
          headers: { host: new URL(url).host },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });

  return {
    connect,
    get,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// The carve-out through the patched runtime's real HTTP proxy, CONNECT and absolute-form, against
// real loopback listeners.
describe("the patched proxy on a granted loopback port", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });
  const track = <T extends { close: () => Promise<void> }>(item: T): T => {
    cleanups.push(item.close);
    return item;
  };

  it("reaches a granted listener by every spelling of its address and refuses the rest", async () => {
    const granted = track(await listener("127.0.0.1", "granted"));
    const other = track(await listener("127.0.0.1", "ungranted"));
    const proxy = track(await patchedProxy({ allowedLoopbackPorts: [granted.port] }));
    const p = granted.port;
    for (const host of [
      "127.0.0.1",
      "127.1",
      "[::ffff:127.0.0.1]",
      "localhost",
      "LOCALHOST",
      "localhost.",
    ]) {
      expect(await proxy.connect(`${host}:${p}`), `CONNECT ${host}`).toEqual({
        status: 200,
        body: "granted",
      });
      expect(await proxy.get(`http://${host}:${p}/`), `GET ${host}`).toEqual({
        status: 200,
        body: "granted",
      });
    }
    // an ungranted port with a live listener, another loopback address, the unspecified address
    for (const authority of [
      `127.0.0.1:${other.port}`,
      `localhost:${other.port}`,
      `127.0.0.2:${p}`,
      `0.0.0.0:${p}`,
    ]) {
      expect((await proxy.connect(authority)).status, `CONNECT ${authority}`).toBe(403);
      expect((await proxy.get(`http://${authority}/`)).status, `GET ${authority}`).toBe(403);
    }
  });

  it.skipIf(!hasIpv6Loopback)(
    "dials a granted localhost at ::1 when nothing listens on 127.0.0.1",
    async () => {
      const v6 = track(await listener("::1", "v6"));
      const proxy = track(await patchedProxy({ allowedLoopbackPorts: [v6.port] }));
      expect(await proxy.connect(`localhost:${v6.port}`)).toEqual({ status: 200, body: "v6" });
      expect(await proxy.get(`http://localhost:${v6.port}/`)).toEqual({ status: 200, body: "v6" });
      expect(await proxy.connect(`[::1]:${v6.port}`)).toEqual({ status: 200, body: "v6" });
      // a literal grant stays exact: 127.0.0.1 never falls back to ::1
      expect((await proxy.connect(`127.0.0.1:${v6.port}`)).status).toBe(502);
    },
  );

  it.skipIf(!hasIpv6Loopback)(
    "dials a granted localhost at 127.0.0.1 when nothing listens on ::1",
    async () => {
      const v4 = track(await listener("127.0.0.1", "v4"));
      const proxy = track(await patchedProxy({ allowedLoopbackPorts: [v4.port] }));
      expect(await proxy.connect(`localhost:${v4.port}`)).toEqual({ status: 200, body: "v4" });
      expect(await proxy.get(`http://localhost:${v4.port}/`)).toEqual({ status: 200, body: "v4" });
      // a literal grant stays exact: ::1 never falls back to 127.0.0.1
      expect((await proxy.connect(`[::1]:${v4.port}`)).status).toBe(502);
    },
  );

  it.skipIf(!hasIpv6Loopback)("prefers 127.0.0.1 when both listen", async () => {
    const v4 = track(await listener("127.0.0.1", "v4"));
    const v6 = track(await listener("::1", "v6", v4.port));
    const proxy = track(await patchedProxy({ allowedLoopbackPorts: [v4.port] }));
    expect(await proxy.connect(`localhost:${v4.port}`)).toEqual({ status: 200, body: "v4" });
    expect(await proxy.connect(`[::1]:${v6.port}`)).toEqual({ status: 200, body: "v6" });
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

  // Apple's LibreSSL (/usr/bin/curl, the Command Line Tools' python3) falls back to this agent
  // when /etc/ssl/cert.pem lacks a chain's anchor: the one Mach service TLS trust needs
  const trust = { allowMachLookup: ["com.apple.TrustEvaluationAgent"] };

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
        ...trust,
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
        ...trust,
      },
    });
    const { NetworkConfigSchema } = await load("sandbox-config.js");
    expect(NetworkConfigSchema.parse(allowlist.network)).toMatchObject(allowlist.network);
  });

  it("adds allowedLoopbackPorts only for granted ports", async () => {
    const granted = macNetworkConfig({ hosts: [], loopbackPorts: [3999] });
    expect(granted.network.allowedLoopbackPorts).toEqual([3999]);
    expect(granted.network).toMatchObject(closed);
    expect(macNetworkConfig({ hosts: [] }).network).not.toHaveProperty("allowedLoopbackPorts");
    expect(macNetworkConfig({ hosts: [], loopbackPorts: [] }).network).not.toHaveProperty(
      "allowedLoopbackPorts",
    );
    // the patched runtime's schema takes it as written
    const { NetworkConfigSchema } = await load("sandbox-config.js");
    expect(NetworkConfigSchema.parse(granted.network)).toMatchObject(granted.network);
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
    // links are exact denies, never subtrees; nothing unlinked under home is listed but the
    // home-anchored ~/bin, which is always denied
    expect(subtrees.filter((d) => d.startsWith(`${home}/`))).toEqual([join(home, "bin")]);
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
