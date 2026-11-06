import { Agent, createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyKeepAlive,
  DEFAULT_KEEP_ALIVE_MS,
  KEEP_ALIVE_ENV,
  parseKeepAliveTimeout,
} from "../src/lib/keep-alive";

describe("parseKeepAliveTimeout", () => {
  it("unset or empty means the default, above a 60 s load balancer idle timeout", () => {
    expect(parseKeepAliveTimeout(undefined)).toBe(DEFAULT_KEEP_ALIVE_MS);
    expect(parseKeepAliveTimeout(" ")).toBe(DEFAULT_KEEP_ALIVE_MS);
    expect(DEFAULT_KEEP_ALIVE_MS).toBeGreaterThan(60_000);
  });

  it("takes a positive integer of milliseconds", () => {
    expect(parseKeepAliveTimeout("120000")).toBe(120_000);
  });

  it.each(["0", "-1", "1.5", "65s", "abc"])("refuses %j", (raw) => {
    expect(() => parseKeepAliveTimeout(raw)).toThrow(KEEP_ALIVE_ENV);
  });
});

describe("applyKeepAlive", () => {
  let server: Server | undefined;
  let agent: Agent | undefined;
  afterEach(async () => {
    agent?.destroy();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r) ?? r(undefined));
    server = agent = undefined;
  });

  it("keeps headersTimeout above the keep-alive timeout", () => {
    server = createServer();
    applyKeepAlive(server, 120_000);
    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBeGreaterThan(120_000);
  });

  // Issue #60: with Node's defaults the server closes an idle connection after 6 s (5 s plus a 1 s
  // buffer) while a keep-alive client such as Playwright's page.request still reuses it, and a
  // request sent at that moment fails with ECONNRESET. Configured as server.mjs does, the
  // connection is still open, and reused, after that point.
  it("a connection idle past Node's default close is still reused", async () => {
    let connections = 0;
    server = createServer((_req, res) => res.end("ok"));
    server.on("connection", () => connections++);
    applyKeepAlive(server, parseKeepAliveTimeout(undefined));
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const keepAlive = new Agent({ keepAlive: true });
    agent = keepAlive;
    const request = () =>
      new Promise<number | undefined>((ok, fail) => {
        get({ host: "127.0.0.1", port, agent: keepAlive }, (res) => {
          res.resume();
          res.on("end", () => ok(res.statusCode));
        }).on("error", fail);
      });

    expect(await request()).toBe(200);
    await new Promise((r) => setTimeout(r, 6_100));
    expect(await request()).toBe(200);
    expect(connections).toBe(1);
  }, 15_000);
});
