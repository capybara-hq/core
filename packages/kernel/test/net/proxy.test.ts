import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  type AddressInfo,
  createServer as createNetServer,
  connect as netConnect,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { type FakeGitServer, startFakeGitServer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveGitCommit } from "../../src/catalog/git-source.js";
import { bypassesProxy, proxyAgent, proxyUrlProblem } from "../../src/net/proxy.js";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../../src/net/public-address.js";
import { pinnedAgent, safeFetch } from "../../src/net/safe-fetch.js";

// --- a self-signed certificate (P-256, DER built by hand: no openssl, no extra dependency) ---

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const utcTime = (d: Date) =>
  tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));

/** A self-signed CA:TRUE certificate for `dns` names and IPv4 `ips`, PEM, with its key. */
function selfSigned(dns: string[], ips: string[]): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(dns[0] ?? "test")))));
  const serial = randomBytes(8);
  serial[0] = (serial[0] as number) & 0x7f;
  const san = seq(
    ...dns.map((d) => tlv(0x82, Buffer.from(d))),
    ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
  );
  const extensions = tlv(
    0xa3,
    seq(
      seq(
        oid("2.5.29.19"),
        tlv(0x01, Buffer.from([0xff])),
        tlv(0x04, seq(tlv(0x01, Buffer.from([0xff])))),
      ),
      seq(oid("2.5.29.17"), tlv(0x04, san)),
    ),
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name,
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

const { cert, key } = selfSigned(
  ["target.example", "direct.example", "git.example"],
  ["127.0.0.1", "10.1.2.3"],
);

// --- a TLS target and CONNECT proxies (plain http and https) ---

let target: Server;
let targetPort: number;
const targetSeen: { host: string | undefined; url: string }[] = [];

type ProxyMode = "tunnel" | "refuse";
type ProxyLog = { connects: string[]; auth: (string | undefined)[] };
let mode: ProxyMode = "tunnel";
/** Where the proxy tunnels every CONNECT (it is the proxy that "resolves" the target). */
let tunnelPort = 0;

function onConnect(log: ProxyLog) {
  return (req: IncomingMessage, client: Socket, head: Buffer) => {
    log.connects.push(req.url ?? "");
    log.auth.push(req.headers["proxy-authorization"]);
    if (mode === "refuse") {
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = netConnect(tunnelPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
}

let httpProxy: Server;
let httpsProxy: Server;
let httpProxyPort: number;
let httpsProxyPort: number;
const httpLog: ProxyLog = { connects: [], auth: [] };
const httpsLog: ProxyLog = { connects: [], auth: [] };

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};
const close = async (s: Server | undefined) => {
  if (!s) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
};

beforeAll(async () => {
  target = createHttpsServer({ cert, key }, (req, res) => {
    targetSeen.push({ host: req.headers.host, url: req.url ?? "" });
    res.end("ok");
  });
  targetPort = await listen(target);
  httpProxy = createHttpServer((_req, res) => res.writeHead(405).end());
  httpProxy.on("connect", onConnect(httpLog));
  httpProxyPort = await listen(httpProxy);
  httpsProxy = createHttpsServer({ cert, key }, (_req, res) => res.writeHead(405).end());
  httpsProxy.on("connect", onConnect(httpsLog));
  httpsProxyPort = await listen(httpsProxy);
});
afterAll(async () => {
  await Promise.all([close(target), close(httpProxy), close(httpsProxy)]);
});
beforeEach(() => {
  mode = "tunnel";
  tunnelPort = targetPort;
  targetSeen.length = 0;
  for (const l of [httpLog, httpsLog]) {
    l.connects.length = 0;
    l.auth.length = 0;
  }
});

const policy = (over: Partial<NetPolicy> = {}, proxyUrl?: string): NetPolicy => ({
  allowInsecureLoopback: false,
  allowPrivateHosts: [],
  trustedOrigins: [],
  proxy: { url: proxyUrl ?? `http://127.0.0.1:${httpProxyPort}`, noProxy: [] },
  ...over,
});
const init = () => ({ signal: AbortSignal.timeout(5_000) });
/** The kernel's own DNS must never be asked for a proxied target. */
const noLookup: LookupFn = async (host) => {
  throw new Error(`resolved ${host} locally`);
};
const viaProxy = {
  lookup: noLookup,
  proxyDispatcherFor: (u: string) => proxyAgent(u, { ca: cert }),
};

async function denied(p: Promise<unknown>): Promise<NetDeniedError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(NetDeniedError);
  return e as NetDeniedError;
}

describe("safeFetch through an egress proxy", () => {
  it("tunnels with CONNECT, sends Basic proxy credentials and never resolves the target", async () => {
    const url = `http://capy:p%40ss@127.0.0.1:${httpProxyPort}`;
    const res = await safeFetch(
      `https://target.example:${targetPort}/x`,
      init(),
      policy({}, url),
      viaProxy,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(httpLog.connects).toEqual([`target.example:${targetPort}`]);
    expect(httpLog.auth).toEqual([`Basic ${Buffer.from("capy:p@ss").toString("base64")}`]);
    expect(targetSeen).toEqual([{ host: `target.example:${targetPort}`, url: "/x" }]);
  });

  it("works with an https proxy", async () => {
    const res = await safeFetch(
      `https://target.example:${targetPort}/s`,
      init(),
      policy({}, `https://127.0.0.1:${httpsProxyPort}`),
      {
        lookup: noLookup,
        proxyDispatcherFor: (u) => proxyAgent(u, { ca: cert, proxyCa: cert }),
      },
    );
    expect(await res.text()).toBe("ok");
    expect(httpsLog.connects).toEqual([`target.example:${targetPort}`]);
    expect(httpsLog.auth).toEqual([undefined]);
  });

  it("refuses a private IP-literal target before contacting the proxy", async () => {
    const e = await denied(safeFetch("https://10.0.0.1/x", init(), policy(), viaProxy));
    expect(e).toMatchObject({ code: "net.private_address", host: "10.0.0.1" });
    // link-local stays refused whatever the exemptions
    const metadata = await denied(
      safeFetch(
        "https://169.254.169.254/latest",
        init(),
        policy({ allowPrivateHosts: ["169.254.0.0/16"] }),
        viaProxy,
      ),
    );
    expect(metadata.code).toBe("net.private_address");
    expect(httpLog.connects).toEqual([]);
  });

  it("lets an IP-literal target exempted by allowPrivateHosts through the proxy", async () => {
    const res = await safeFetch(
      `https://10.1.2.3:${targetPort}/lit`,
      init(),
      policy({ allowPrivateHosts: ["10.1.0.0/16"] }),
      viaProxy,
    );
    expect(await res.text()).toBe("ok");
    expect(httpLog.connects).toEqual([`10.1.2.3:${targetPort}`]);
  });

  it("goes direct for a noProxy host, resolving and pinning it locally", async () => {
    let lookups = 0;
    const lookup: LookupFn = async () => {
      lookups += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const p = policy({ allowPrivateHosts: ["direct.example"] });
    p.proxy = { url: p.proxy?.url ?? "", noProxy: ["example"] };
    const pinned: string[][] = [];
    const res = await safeFetch(`https://direct.example:${targetPort}/d`, init(), p, {
      lookup,
      dispatcherFor: (ips) => {
        pinned.push(ips);
        return pinnedAgent(ips, { ca: cert });
      },
      proxyDispatcherFor: () => {
        throw new Error("the proxy must not be used");
      },
    });
    expect(await res.text()).toBe("ok");
    expect(lookups).toBe(1);
    expect(pinned).toEqual([["127.0.0.1"]]);
    expect(httpLog.connects).toEqual([]);
  });

  it("a proxy answering 403 is net.proxy_refused, without the credentials", async () => {
    mode = "refuse";
    const e = await denied(
      safeFetch(
        `https://target.example:${targetPort}/x`,
        init(),
        policy({}, `http://capy:hunter2@127.0.0.1:${httpProxyPort}`),
        viaProxy,
      ),
    );
    expect(e.code).toBe("net.proxy_refused");
    expect(e.host).toBe("target.example");
    expect(e.message).toContain("403");
    expect(e.message).not.toContain("hunter2");
    expect(e.message).not.toContain("capy");
    expect(targetSeen).toEqual([]);
  });

  it("an unreachable proxy fails without echoing the credentials", async () => {
    const closed = createHttpServer();
    const port = await listen(closed);
    await close(closed);
    const e = await safeFetch(
      `https://target.example:${targetPort}/x`,
      init(),
      policy({}, `http://capy:hunter2@127.0.0.1:${port}`),
      viaProxy,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    const text = `${(e as Error).message} ${String((e as { cause?: Error }).cause?.message)}`;
    expect(text).toContain(`127.0.0.1:${port}`);
    expect(text).not.toContain("hunter2");
  });

  it("loopback http under allowInsecureLoopback never goes through the proxy", async () => {
    const plain = createHttpServer((_req, res) => res.end("plain"));
    const port = await listen(plain);
    try {
      const res = await safeFetch(
        `http://127.0.0.1:${port}/`,
        init(),
        policy({ allowInsecureLoopback: true }),
        viaProxy,
      );
      expect(await res.text()).toBe("plain");
      expect(httpLog.connects).toEqual([]);
    } finally {
      await close(plain);
    }
  });
});

/** A raw TCP "proxy" that answers every CONNECT with `answer` (it never tunnels). */
async function rawProxy(answer: (client: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    let seen = "";
    client.on("data", (d: Buffer) => {
      if (seen.includes("\r\n\r\n")) return;
      seen += d.toString("latin1");
      if (seen.includes("\r\n\r\n")) answer(client);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://capy:hunter2@127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const c of sockets) c.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** The fetch error's message and its cause's message, joined. */
async function failure(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(Error);
  return `${(e as Error).message} ${String((e as { cause?: Error }).cause?.message)}`;
}

describe("the tunnel itself", () => {
  it("refuses a target certificate for another name sent through the tunnel", async () => {
    // TLS to the target runs over the tunnel and verifies the target's hostname, so a proxy (or
    // anything behind it) cannot answer for target.example with another name's certificate
    const other = selfSigned(["other.example"], []);
    const impostor = createHttpsServer({ cert: other.cert, key: other.key }, (_req, res) =>
      res.end("impostor"),
    );
    tunnelPort = await listen(impostor);
    try {
      const text = await failure(
        safeFetch(`https://target.example:${targetPort}/x`, init(), policy(), {
          lookup: noLookup,
          proxyDispatcherFor: (u) => proxyAgent(u, { ca: [cert, other.cert] }),
        }),
      );
      expect(text).toMatch(/altnames|does not match|ERR_TLS_CERT_ALTNAME_INVALID/i);
      expect(httpLog.connects).toEqual([`target.example:${targetPort}`]);
    } finally {
      await close(impostor);
    }
  });

  it("refuses a malformed CONNECT answer", async () => {
    const proxy = await rawProxy((c) => c.write("garbage\r\n\r\n"));
    try {
      const text = await failure(
        safeFetch(
          `https://target.example:${targetPort}/x`,
          init(),
          policy({}, proxy.url),
          viaProxy,
        ),
      );
      expect(text).toContain("invalid response to CONNECT");
      expect(text).not.toContain("hunter2");
    } finally {
      await proxy.close();
    }
  });

  it("refuses an oversized CONNECT answer head, even when it arrives with its terminator", async () => {
    const proxy = await rawProxy((c) =>
      c.write(`HTTP/1.1 200 OK\r\nX-Pad: ${"a".repeat(20 * 1024)}\r\n\r\n`),
    );
    try {
      const text = await failure(
        safeFetch(
          `https://target.example:${targetPort}/x`,
          init(),
          policy({}, proxy.url),
          viaProxy,
        ),
      );
      expect(text).toContain("the proxy response head is too large");
      expect(targetSeen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("gives up on a proxy that trickles its answer: one total deadline, not an idle timeout", async () => {
    const timers: NodeJS.Timeout[] = [];
    const proxy = await rawProxy((c) => {
      c.write("HTTP/1.1 200 OK\r\nX-Slow: ");
      // A byte every 50 ms would keep an idle timeout from ever firing
      timers.push(setInterval(() => c.writable && c.write("a"), 50));
    });
    try {
      const started = Date.now();
      const text = await failure(
        safeFetch(`https://target.example:${targetPort}/x`, init(), policy({}, proxy.url), {
          lookup: noLookup,
          proxyDispatcherFor: (u) => proxyAgent(u, { ca: cert, tunnelTimeoutMs: 400 }),
        }),
      );
      expect(text).toContain("did not answer CONNECT in time");
      expect(text).toContain("127.0.0.1:");
      expect(text).not.toContain("hunter2");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      for (const t of timers) clearInterval(t);
      await proxy.close();
    }
  });
});

describe("proxy helpers", () => {
  it("bypassesProxy matches an entry and its subdomains only", () => {
    const list = ["internal.example", ".corp.example", "10.0.0.5"];
    expect(bypassesProxy("internal.example", list)).toBe(true);
    expect(bypassesProxy("git.internal.example", list)).toBe(true);
    expect(bypassesProxy("GIT.Corp.Example.", list)).toBe(true);
    expect(bypassesProxy("corp.example", list)).toBe(true);
    expect(bypassesProxy("notinternal.example", list)).toBe(false);
    expect(bypassesProxy("10.0.0.5", list)).toBe(true);
    expect(bypassesProxy("110.0.0.5", list)).toBe(false);
  });

  it("proxyUrlProblem accepts http(s) URLs only and never echoes the value", () => {
    expect(proxyUrlProblem("http://u:secret@proxy:3128")).toBeUndefined();
    expect(proxyUrlProblem("https://proxy.internal")).toBeUndefined();
    expect(proxyUrlProblem("http://secret%zz:x@proxy:3128")).toBe(
      "the user name or password is not valid percent-encoding",
    );
    expect(proxyUrlProblem("http://u:secret%E0%A4%A@proxy:3128")).toBe(
      "the user name or password is not valid percent-encoding",
    );
    for (const bad of ["socks5://u:secret@p:1080", "http://u:secret@p:3128/path", "secret"]) {
      const problem = proxyUrlProblem(bad);
      expect(problem).toBeDefined();
      expect(problem).not.toContain("secret");
    }
  });
});

// --- a git marketplace behind the proxy, with a fake-IP resolver ---

describe("git through the egress proxy", () => {
  let git: FakeGitServer;
  let front: tls.Server;
  let tempRoot: string;
  const defaults = tls.getCACertificates("default");

  beforeAll(async () => {
    git = await startFakeGitServer();
    const gitPort = Number(new URL(git.url("x")).port);
    // a TLS front for the fake git server: the proxy tunnels to it
    front = tls.createServer({ cert, key }, (s) => {
      const up = netConnect(gitPort, "127.0.0.1");
      s.pipe(up).pipe(s);
      up.on("error", () => s.destroy());
      s.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    tempRoot = await mkdtemp(join(tmpdir(), "proxy-git-test-"));
    // git-source builds its own dispatchers: trust the test certificate process-wide here
    tls.setDefaultCACertificates([...defaults, cert]);
  });
  afterAll(async () => {
    tls.setDefaultCACertificates(defaults);
    await git?.stop();
    if (front) await new Promise((r) => front.close(r));
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });
  afterEach(() => {
    tunnelPort = targetPort;
  });

  it("resolves a commit through the proxy although local DNS would answer a fake IP", async () => {
    const head = await git.commit("market", { "marketplace.json": "{}" });
    tunnelPort = (front.address() as AddressInfo).port;
    // without the proxy, git.example would be checked against the local resolver; with it, never
    const sha = await resolveGitCommit(
      { url: `https://git.example:${tunnelPort}/market.git` },
      {
        net: policy(),
        signal: AbortSignal.timeout(30_000),
        maxBytes: 10 * 1024 * 1024,
        tempRoot,
      },
    );
    expect(sha).toBe(head);
    expect(httpLog.connects.every((c) => c === `git.example:${tunnelPort}`)).toBe(true);
    expect(httpLog.connects.length).toBeGreaterThan(0);
  });
});
