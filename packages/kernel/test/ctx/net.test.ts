import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect as netConnect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { isNetDeniedError, NetDeniedError as SdkNetDeniedError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres } from "@capybara-hq/testing";
import { Agent, buildConnector } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExtensionNet, NO_ORG_PRIVATE_HINT, ORG_PRIVATE_HINT } from "../../src/ctx/net.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { proxyAgent } from "../../src/net/proxy.js";
import type { LookupFn } from "../../src/net/public-address.js";
import { OrgNetworkAllowances } from "../../src/orgs/network-allowances.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, handlesFor, orgLockFor, orgsFor } from "../helpers/identity.js";
import { selfSigned } from "../net/self-signed.js";

// ctx.net.fetch (plugin safe fetch spec): safeFetch with per-org allowances read from PG per call.
// Hostnames resolve through a fake DNS table; every checked connection is redirected to the local
// fake servers on 127.0.0.1 (the dispatcher seam), recording the addresses the kernel pinned.

const NAMES = [
  "public.example",
  "mcp.internal",
  "other.internal",
  "api.corp.example",
  "svc.corp.example",
  "corp.example",
  "ten.example",
  "loop.internal",
  "meta.internal",
  "target.example",
];
const { cert, key } = selfSigned(NAMES, ["127.0.0.1", "10.1.2.3"]);

const DNS: Record<string, string> = {
  "public.example": "93.184.216.34",
  "mcp.internal": "10.0.0.5",
  "other.internal": "10.0.0.6",
  "api.corp.example": "10.2.0.1",
  "svc.corp.example": "10.2.0.2",
  "corp.example": "10.2.0.3",
  "ten.example": "10.1.2.3",
  "loop.internal": "127.0.0.1",
  "meta.internal": "169.254.169.254",
};
const lookup: LookupFn = async (host) => {
  const address = DNS[host];
  if (address === undefined) throw new Error(`no such host ${host}`);
  return [{ address, family: address.includes(":") ? 6 : 4 }];
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const ok: Handler = (_req, res) => res.end("ok");
let handler: Handler = ok;
const seen: string[] = [];
const serve = (req: IncomingMessage, res: ServerResponse) => {
  seen.push(`${req.headers.host}${req.url}`);
  handler(req, res);
};

let tlsServer: Server;
let httpServer: Server;
let otherHttpServer: Server;
let proxy: Server;
let tlsPort: number;
let httpPort: number;
let otherHttpPort: number;
let proxyPort: number;
const connects: string[] = [];
/** Addresses the kernel pinned connections to (the dispatcher seam). */
const pinned: string[][] = [];

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};
const close = async (s: Server) => {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
};

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let allowances: OrgNetworkAllowances;
let actorId: string;
let orgA: string;
let orgB: string;

type NetConfig = {
  allowInsecureLoopback: boolean;
  httpsProxy?: string;
  noProxy: string[];
};
let netConfig: NetConfig;
const config = { get: () => ({ net: netConfig }) } as unknown as KernelConfigService;
const warnings: { msg: string; fields: Record<string, unknown> | undefined }[] = [];

function makeNet(signal: AbortSignal = new AbortController().signal) {
  return createExtensionNet({
    config,
    allowances,
    log: { warn: (msg, fields) => warnings.push({ msg, fields }) },
    plugin: "connector-test",
    signal,
    seams: {
      lookup,
      dispatcherFor: (ips) => {
        pinned.push(ips);
        return toLocalServers();
      },
      proxyDispatcherFor: (u) => proxyAgent(u, { ca: cert }),
    },
  });
}

/**
 * A dispatcher whose connections all go to 127.0.0.1 (the URL's port kept), for names and IP
 * literals alike: an IP-literal host never goes through `connect.lookup`, so the pinned agent's
 * lookup cannot redirect it.
 */
function toLocalServers(): Agent {
  const connect = buildConnector({ ca: cert });
  return new Agent({ connect: (opts, cb) => connect({ ...opts, hostname: "127.0.0.1" }, cb) });
}

async function refused(p: Promise<unknown>): Promise<SdkNetDeniedError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  // the SDK's error, recognizable by name across package copies
  expect(e).toBeInstanceOf(SdkNetDeniedError);
  expect(isNetDeniedError(e)).toBe(true);
  return e as SdkNetDeniedError;
}

const allow = (orgId: string, entry: string) =>
  allowances.add(orgId, entry, { accountId: actorId });

beforeAll(async () => {
  tlsServer = createHttpsServer({ cert, key }, serve);
  tlsPort = await listen(tlsServer);
  httpServer = createHttpServer(serve);
  httpPort = await listen(httpServer);
  otherHttpServer = createHttpServer(serve);
  otherHttpPort = await listen(otherHttpServer);
  // a CONNECT proxy that "resolves" every target to the TLS server
  proxy = createHttpServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    connects.push(req.url ?? "");
    const upstream = netConnect(tlsPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  proxyPort = await listen(proxy);

  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  const h = handlesFor(db);
  allowances = new OrgNetworkAllowances(h.db, h.txHost, orgLockFor(db));
});

afterAll(async () => {
  await Promise.all([close(tlsServer), close(httpServer), close(otherHttpServer), close(proxy)]);
  await raw.destroy();
  await pg.stop();
});

beforeEach(async () => {
  handler = ok;
  seen.length = 0;
  connects.length = 0;
  pinned.length = 0;
  warnings.length = 0;
  netConfig = { allowInsecureLoopback: false, noProxy: [] };
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.memberships, capybara.audit_events, capybara.org_network_allowances",
  );
  const root = await accountsFor(db).createLocal({
    login: "root",
    password: "correct horse battery",
    displayName: "Root",
  });
  actorId = root.id;
  orgA = (await orgsFor(db).create({ name: "Acme" }, root)).id;
  orgB = (await orgsFor(db).create({ name: "Other" }, root)).id;
});

describe("ctx.net.fetch: the network rules", () => {
  it("fetches a public https URL, pinned to the checked address", async () => {
    const res = await makeNet().fetch(`https://public.example:${tlsPort}/x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(pinned).toEqual([["93.184.216.34"]]);
    expect(seen).toEqual([`public.example:${tlsPort}/x`]);
  });

  it("refuses plain http to a non-loopback host and a host that resolves to a private address", async () => {
    const net = makeNet();
    const http = await refused(
      net.fetch(`http://public.example:${httpPort}/`, {}, { orgId: orgA }),
    );
    expect(http).toMatchObject({ code: "net.insecure_url", host: "public.example" });

    const priv = await refused(
      net.fetch("https://mcp.internal/secret?token=x", {}, { orgId: orgA }),
    );
    expect(priv).toMatchObject({ code: "net.private_address", host: "mcp.internal" });
    expect(priv.message).toBe(
      `Access to mcp.internal is refused: it resolves to a private or reserved address (${ORG_PRIVATE_HINT}).`,
    );
    expect(seen).toEqual([]);
    // logged at warn with plugin, org, host and code: never the path, query or headers
    expect(warnings.at(-1)).toEqual({
      msg: "ctx.net.fetch refused a request",
      fields: {
        plugin: "connector-test",
        orgId: orgA,
        host: "mcp.internal",
        code: "net.private_address",
      },
    });
    expect(JSON.stringify(warnings)).not.toContain("secret");
  });

  it("refuses a 3xx with net.redirect by default and returns it with redirect: manual", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "https://mcp.internal/" }).end();
    const net = makeNet();
    const e = await refused(net.fetch(`https://public.example:${tlsPort}/start`));
    expect(e).toMatchObject({ code: "net.redirect", host: "public.example", status: 302 });
    const res = await net.fetch(`https://public.example:${tlsPort}/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://mcp.internal/");
    // the target was never requested
    expect(seen).toEqual([`public.example:${tlsPort}/start`, `public.example:${tlsPort}/start`]);
  });

  it("streams a chunked response: the first chunk arrives before the server ends", async () => {
    let finish = () => {};
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      finish = () => res.end("data: two\n\n");
    };
    const res = await makeNet().fetch(`https://public.example:${tlsPort}/sse`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    finish();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      rest += new TextDecoder().decode(r.value);
    }
    expect(rest).toBe("data: two\n\n");
  });

  it("aborts with ctx.signal and with the caller's signal", async () => {
    let arrived = () => {};
    handler = () => arrived(); // never answers
    const lifecycle = new AbortController();
    const net = makeNet(lifecycle.signal);
    const waiting = new Promise<void>((r) => {
      arrived = r;
    });
    const pending = net.fetch(`https://public.example:${tlsPort}/hang`);
    await waiting;
    lifecycle.abort(new Error("extension revoked"));
    await expect(pending).rejects.toThrow("extension revoked");

    const caller = new AbortController();
    const second = new Promise<void>((r) => {
      arrived = r;
    });
    const mine = makeNet().fetch(`https://public.example:${tlsPort}/hang`, {
      signal: caller.signal,
    });
    await second;
    caller.abort(new Error("caller gave up"));
    await expect(mine).rejects.toThrow("caller gave up");
  });
});

describe("ctx.net.fetch: org allowances", () => {
  it("an origin allowance allows exactly that origin, plain http included", async () => {
    await allow(orgA, `http://mcp.internal:${httpPort}`);
    const net = makeNet();
    const res = await net.fetch(`http://mcp.internal:${httpPort}/mcp`, {}, { orgId: orgA });
    expect(await res.text()).toBe("ok");
    expect(pinned).toEqual([["10.0.0.5"]]);
    // another port, another scheme, another host: refused before connecting
    const port = await refused(
      net.fetch(`http://mcp.internal:${otherHttpPort}/mcp`, {}, { orgId: orgA }),
    );
    expect(port.code).toBe("net.insecure_url");
    const scheme = await refused(
      net.fetch(`https://mcp.internal:${httpPort}/mcp`, {}, { orgId: orgA }),
    );
    expect(scheme.code).toBe("net.private_address");
    const other = await refused(
      net.fetch(`https://other.internal:${tlsPort}/`, {}, { orgId: orgA }),
    );
    expect(other.code).toBe("net.private_address");
    expect(seen).toEqual([`mcp.internal:${httpPort}/mcp`]);
  });

  it("a CIDR allowance allows IP-literal hosts in it over https, never a name resolving there", async () => {
    await allow(orgA, "10.1.0.0/16");
    const net = makeNet();
    const res = await net.fetch(`https://10.1.2.3:${tlsPort}/lit`, {}, { orgId: orgA });
    expect(await res.text()).toBe("ok");
    const named = await refused(net.fetch(`https://ten.example:${tlsPort}/`, {}, { orgId: orgA }));
    expect(named).toMatchObject({ code: "net.private_address", host: "ten.example" });
    // a host entry is https only
    const http = await refused(net.fetch(`http://10.1.2.3:${httpPort}/`, {}, { orgId: orgA }));
    expect(http.code).toBe("net.insecure_url");
    expect(http.message).toContain(`allow the origin http://10.1.2.3:${httpPort}`);
  });

  it("a host allowance applies to its org only; no org means public addresses only", async () => {
    await allow(orgA, "api.corp.example");
    const net = makeNet();
    const url = `https://api.corp.example:${tlsPort}/v1`;
    expect((await net.fetch(url, {}, { orgId: orgA })).status).toBe(200);
    const b = await refused(net.fetch(url, {}, { orgId: orgB }));
    expect(b.message).toContain(ORG_PRIVATE_HINT);
    const none = await refused(net.fetch(url));
    expect(none.message).toContain(NO_ORG_PRIVATE_HINT);
    expect(warnings.map((w) => w.fields?.orgId)).toEqual([orgB, null]);
  });

  it("a *.domain allowance covers names under the domain over https, not the apex", async () => {
    await allow(orgA, "*.corp.example");
    const net = makeNet();
    expect(
      (await net.fetch(`https://svc.corp.example:${tlsPort}/`, {}, { orgId: orgA })).status,
    ).toBe(200);
    const apex = await refused(net.fetch(`https://corp.example:${tlsPort}/`, {}, { orgId: orgA }));
    expect(apex.code).toBe("net.private_address");
    const http = await refused(
      net.fetch(`http://svc.corp.example:${httpPort}/`, {}, { orgId: orgA }),
    );
    expect(http.code).toBe("net.insecure_url");
    expect(http.message).toContain(
      `svc.corp.example is allowed for the organization over https only; to allow plain http, ask a super admin to allow the origin http://svc.corp.example:${httpPort}.`,
    );
    // no hint for a host the org does not allow at all
    const plain = await refused(
      net.fetch(`http://public.example:${httpPort}/`, {}, { orgId: orgA }),
    );
    expect(plain.message).toBe("The URL must use https (public.example).");
  });

  it("removing an allowance refuses the next request", async () => {
    const entry = await allow(orgA, "api.corp.example");
    const net = makeNet();
    const url = `https://api.corp.example:${tlsPort}/v1`;
    expect((await net.fetch(url, {}, { orgId: orgA })).status).toBe(200);
    expect(await allowances.remove(orgA, entry.id, { accountId: actorId })).toBe(true);
    expect((await refused(net.fetch(url, {}, { orgId: orgA }))).code).toBe("net.private_address");
  });

  it("an allowed hostname resolving to loopback or link-local is refused", async () => {
    await allow(orgA, "loop.internal");
    await allow(orgA, "meta.internal");
    const net = makeNet();
    const loop = await refused(net.fetch(`https://loop.internal:${tlsPort}/`, {}, { orgId: orgA }));
    expect(loop.message).toMatch(/loopback address \(the kernel's own host\)/);
    const meta = await refused(net.fetch("https://meta.internal/latest", {}, { orgId: orgA }));
    expect(meta.message).toMatch(/link-local or cloud metadata/);
    const literal = await refused(net.fetch("https://169.254.169.254/", {}, { orgId: orgA }));
    expect(literal.code).toBe("net.private_address");
    expect(seen).toEqual([]);
  });
});

describe("ctx.net.fetch: config", () => {
  it("with net.httpsProxy an https request tunnels through the proxy; IP-literal targets are still checked", async () => {
    netConfig = {
      allowInsecureLoopback: false,
      httpsProxy: `http://127.0.0.1:${proxyPort}`,
      noProxy: [],
    };
    const net = makeNet();
    // the proxy resolves the name (and owns SSRF protection for it): no local lookup, no pin
    const res = await net.fetch(`https://target.example:${tlsPort}/p`, {}, { orgId: orgA });
    expect(await res.text()).toBe("ok");
    expect(connects).toEqual([`target.example:${tlsPort}`]);
    expect(pinned).toEqual([]);
    const literal = await refused(net.fetch("https://10.0.0.1/x", {}, { orgId: orgA }));
    expect(literal).toMatchObject({ code: "net.private_address", host: "10.0.0.1" });
    expect(connects).toHaveLength(1);
  });

  it("net.allowInsecureLoopback lets http reach loopback; link-local stays refused", async () => {
    const strict = await refused(makeNet().fetch(`http://127.0.0.1:${httpPort}/`));
    expect(strict.code).toBe("net.insecure_url");
    netConfig = { allowInsecureLoopback: true, noProxy: [] };
    const net = makeNet();
    expect(await (await net.fetch(`http://127.0.0.1:${httpPort}/l`)).text()).toBe("ok");
    const meta = await refused(net.fetch("https://169.254.169.254/latest", {}, { orgId: orgA }));
    expect(meta.code).toBe("net.private_address");
    await allow(orgA, "meta.internal");
    const named = await refused(net.fetch("https://meta.internal/latest", {}, { orgId: orgA }));
    expect(named.message).toMatch(/link-local/);
  });
});
