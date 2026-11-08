import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleUpgrade,
  isDeviceConnectPath,
  parseGatewayProxy,
} from "../src/lib/device-connect-proxy";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.closeAllConnections();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

type Seen = { url: string; headers: IncomingMessage["headers"] };

/** Fake gateway: answers the WebSocket handshake with 101, then echoes every byte prefixed "echo:". */
async function startGateway(seen: Seen[]): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (head.length > 0) socket.write(Buffer.concat([Buffer.from("echo:"), head]));
    socket.on("data", (d: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  return listen(server);
}

/** The web tier under test: only the upgrade listener matters here. */
async function startWeb(gatewayUrl: string): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("next");
  });
  const cfg = parseGatewayProxy({ CAPYBARA_WEB_GATEWAY_URL: gatewayUrl });
  server.on("upgrade", handleUpgrade(cfg));
  return listen(server);
}

type UpgradeResult =
  | { kind: "upgraded"; socket: Socket; head: Buffer; status: number }
  | { kind: "response"; status: number };

function upgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket, head) =>
      resolve({ kind: "upgraded", socket, head, status: res.statusCode ?? 0 }),
    );
    req.on("response", (res) => {
      res.resume();
      resolve({ kind: "response", status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

function nextData(socket: Socket): Promise<string> {
  return new Promise((resolve) => socket.once("data", (d: Buffer) => resolve(d.toString())));
}

describe("parseGatewayProxy", () => {
  it("falls back to the kernel URL, then to http://localhost:8080, when unset or empty", () => {
    expect(parseGatewayProxy({}).upstream.href).toBe("http://localhost:8080/");
    expect(
      parseGatewayProxy({ CAPYBARA_WEB_GATEWAY_URL: "  ", CAPYBARA_KERNEL_URL: "http://api:8080" })
        .upstream.host,
    ).toBe("api:8080");
    expect(
      parseGatewayProxy({
        CAPYBARA_WEB_GATEWAY_URL: "http://gateway:8080",
        CAPYBARA_KERNEL_URL: "http://api:8080",
      }).upstream.host,
    ).toBe("gateway:8080");
  });

  it("takes an http(s) URL and refuses anything else", () => {
    expect(
      parseGatewayProxy({ CAPYBARA_WEB_GATEWAY_URL: "http://gateway:8080" })?.upstream.host,
    ).toBe("gateway:8080");
    expect(() => parseGatewayProxy({ CAPYBARA_WEB_GATEWAY_URL: "ws://gateway:8080" })).toThrow(
      /http\(s\) URL/,
    );
    expect(() => parseGatewayProxy({ CAPYBARA_WEB_GATEWAY_URL: "not a url" })).toThrow(
      /http\(s\) URL/,
    );
  });
});

describe("isDeviceConnectPath", () => {
  it("matches exactly /device/connect", () => {
    expect(isDeviceConnectPath("/device/connect")).toBe(true);
    expect(isDeviceConnectPath("/device/connect?x=1")).toBe(true);
    expect(isDeviceConnectPath("/device/connect/")).toBe(false);
    expect(isDeviceConnectPath("/device")).toBe(false);
    expect(isDeviceConnectPath("/api/device/connect")).toBe(false);
  });
});

describe("handleUpgrade", () => {
  it("forwards /device/connect with its headers and streams frames both ways", async () => {
    const seen: Seen[] = [];
    const gw = await startGateway(seen);
    const web = await startWeb(`http://127.0.0.1:${gw}`);
    const res = await upgrade(web, "/device/connect", {
      authorization: "Bearer cap_dev_secret",
      "x-capybara-device-protocol": "1",
      cookie: "session=browser",
      "x-forwarded-for": "6.6.6.6",
    });
    expect(res.kind).toBe("upgraded");
    if (res.kind !== "upgraded") return;
    expect(res.status).toBe(101);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/device/connect");
    expect(seen[0]?.headers.authorization).toBe("Bearer cap_dev_secret");
    expect(seen[0]?.headers["x-capybara-device-protocol"]).toBe("1");
    expect(seen[0]?.headers.upgrade).toBe("websocket");
    expect(seen[0]?.headers.host).toBe(`127.0.0.1:${gw}`);
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers["x-forwarded-for"]).toBeUndefined();

    const reply = nextData(res.socket);
    res.socket.write("frame-1");
    expect(await reply).toBe("echo:frame-1");
    res.socket.destroy();
  });

  it("refuses upgrades on any other path with 404", async () => {
    const seen: Seen[] = [];
    const gw = await startGateway(seen);
    const web = await startWeb(`http://127.0.0.1:${gw}`);
    for (const path of ["/_next/hmr", "/device", "/device/connect/x", "/api/v1/stream"]) {
      expect(await upgrade(web, path, {})).toEqual({ kind: "response", status: 404 });
    }
    expect(seen).toHaveLength(0);
  });

  it("hands other paths to the fallback listener when given (dev HMR)", async () => {
    const handed: string[] = [];
    const server = createServer();
    server.on(
      "upgrade",
      handleUpgrade(parseGatewayProxy({}), (req, socket) => {
        handed.push(req.url ?? "");
        socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      }),
    );
    const web = await listen(server);
    expect(await upgrade(web, "/_next/hmr", {})).toEqual({ kind: "response", status: 400 });
    expect(handed).toEqual(["/_next/hmr"]);
  });

  it("answers 502 when the gateway can't be reached", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise((r) => closed.close(r));
    servers.splice(servers.indexOf(closed), 1);
    const web = await startWeb(`http://127.0.0.1:${port}`);
    expect(await upgrade(web, "/device/connect", {})).toEqual({ kind: "response", status: 502 });
  });

  it("closes the client socket when the gateway drops the connection", async () => {
    const seen: Seen[] = [];
    const gwServer = createServer();
    gwServer.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      setTimeout(() => socket.destroy(), 20);
    });
    const gw = await listen(gwServer);
    const web = await startWeb(`http://127.0.0.1:${gw}`);
    const res = await upgrade(web, "/device/connect", {});
    expect(res.kind).toBe("upgraded");
    if (res.kind !== "upgraded") return;
    await new Promise<void>((resolve) => res.socket.on("close", () => resolve()));
    expect(seen).toHaveLength(1);
  });
});
