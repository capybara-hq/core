/**
 * Connected machines on the web origin (server.mjs only; erasable TypeScript syntax only, so Node's
 * type stripping can import it directly, like peer.ts).
 *
 * `capybara-device` opens its WebSocket at `<http.publicUrl>/device/connect`, and the public URL is
 * the web origin. The kernel serves that route only on the `gateway` role, which compose does not
 * publish, so this server forwards WebSocket upgrades whose path is exactly `/device/connect` or
 * `/device/stream` ({@link isGatewayUpgradePath}) to a gateway replica (CAPYBARA_WEB_GATEWAY_URL,
 * an http(s) URL):
 *
 * - The raw socket is piped: the original request line and headers (Authorization,
 *   X-Capybara-Device-Protocol, the WebSocket handshake) go to the gateway, then any bytes the
 *   client already sent, then both directions stream untouched. The gateway answers the handshake
 *   (101, or 401 / 426 with JSON) itself.
 * - `Host` is the gateway's; forwarding headers, cookies and this server's peer marker are not
 *   sent.
 *   A `/device/stream` upgrade alone gets one `X-Forwarded-For`: the client address this server
 *   derived ({@link GatewayProxy.clientOf}), replacing whatever the client sent, so the kernel's
 *   per-address viewer limit (trusted under its `http.trustProxy`, as for `/api`) counts each
 *   client, not this server. `/device/connect` gets none.
 * - An error on either side destroys both sockets; a gateway that can't be reached gets 502.
 * - The gateway is CAPYBARA_WEB_GATEWAY_URL, else the kernel at CAPYBARA_KERNEL_URL.
 *
 * `/device/stream?ticket=…` (the browser live view) is forwarded the same way, query intact; the
 * ticket is a credential and this module never logs it.
 *
 * An external proxy may route `/device/connect` and `/device/stream` to the gateway replicas
 * directly instead; then these upgrades never reach this server.
 */

import type { IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

export const GATEWAY_URL_ENV = "CAPYBARA_WEB_GATEWAY_URL";
export const DEVICE_CONNECT_PATH = "/device/connect";
/**
 * Browser live-view stream; authenticated by a `?ticket=` query, which is a credential: never log
 * it.
 */
export const DEVICE_STREAM_PATH = "/device/stream";

export interface GatewayProxy {
  /** Gateway origin, e.g. http://gateway:8080. */
  upstream: URL;
  /**
   * The client address of a `/device/stream` upgrade (server.mjs: the socket peer, walked through
   * a trusted `x-forwarded-for` chain under CAPYBARA_WEB_TRUST_PROXY, as for `/api`); default the
   * socket peer. Never a client-sent value as such.
   */
  clientOf?: (req: IncomingMessage) => string | undefined;
}

/**
 * Request headers never forwarded (forwarding, cookies, proxy credentials, our marker, the host).
 */
const DROP_REQUEST = new Set([
  "host",
  "cookie",
  "proxy-authorization",
  "proxy-connection",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-capybara-peer-token",
]);

/** Where web reaches the kernel (`CAPYBARA_KERNEL_URL`, the same default as kernel-proxy.ts). */
const DEFAULT_KERNEL_URL = "http://localhost:8080";

/**
 * The gateway web forwards /device/connect and /device/stream to: CAPYBARA_WEB_GATEWAY_URL, else
 * the kernel web already talks to (CAPYBARA_KERNEL_URL, default http://localhost:8080), which runs
 * every role unless the deployment splits them (then CAPYBARA_WEB_GATEWAY_URL names a gateway replica, as compose does).
 * A malformed value throws, so server.mjs stops at startup instead of forwarding nowhere.
 */
export function parseGatewayProxy(env: Record<string, string | undefined>): GatewayProxy {
  const raw = env[GATEWAY_URL_ENV]?.trim() || env.CAPYBARA_KERNEL_URL?.trim() || DEFAULT_KERNEL_URL;
  let upstream: URL;
  try {
    upstream = new URL(raw);
  } catch {
    throw new Error(`${GATEWAY_URL_ENV} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`${GATEWAY_URL_ENV} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  return { upstream };
}

/**
 * Whether a request target's path (query ignored) is one this server pipes to the gateway: exactly
 * `/device/connect` or `/device/stream`.
 */
export function isGatewayUpgradePath(target: string | undefined): boolean {
  const path = (target ?? "").split("?")[0];
  return path === DEVICE_CONNECT_PATH || path === DEVICE_STREAM_PATH;
}

/** Answers an upgrade request with a bodyless status and closes the socket. */
export function refuseUpgrade(socket: Duplex, status: 404 | 502, reason = "Not Found"): void {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** Forwards one upgrade request whose target passed {@link isDeviceConnectPath}. */
export function proxyDeviceConnect(
  cfg: GatewayProxy,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const { upstream: u } = cfg;
  const tls = u.protocol === "https:";
  const port = Number(u.port || (tls ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const up = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });

  let connected = false;
  const destroyBoth = () => {
    up.destroy();
    socket.destroy();
  };
  socket.on("error", destroyBoth);
  socket.on("close", () => up.destroy());
  up.on("error", () => {
    if (!connected) refuseUpgrade(socket, 502, "Bad Gateway");
    else destroyBoth();
  });
  up.on("close", () => socket.destroy());

  up.once(tls ? "secureConnect" : "connect", () => {
    connected = true;
    const lines = [
      `${req.method ?? "GET"} ${req.url ?? DEVICE_CONNECT_PATH} HTTP/1.1`,
      `Host: ${u.host}`,
    ];
    const raw = req.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i] as string;
      if (!DROP_REQUEST.has(name.toLowerCase())) lines.push(`${name}: ${raw[i + 1]}`);
    }
    if ((req.url ?? "").split("?")[0] === DEVICE_STREAM_PATH) {
      const client = cfg.clientOf ? cfg.clientOf(req) : req.socket.remoteAddress;
      // an address only (no header injection through a malformed value)
      if (client !== undefined && /^[0-9A-Fa-f:.]{2,45}$/.test(client))
        lines.push(`X-Forwarded-For: ${client}`);
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
}

export type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * The server's one `upgrade` listener: `/device/connect` and `/device/stream` go to the gateway;
 * any other path goes to `other` when given (dev: Next's HMR socket) and is refused with 404
 * otherwise.
 */
export function handleUpgrade(cfg: GatewayProxy, other?: UpgradeListener): UpgradeListener {
  return (req, socket, head) => {
    if (isGatewayUpgradePath(req.url)) proxyDeviceConnect(cfg, req, socket, head);
    else if (other) other(req, socket, head);
    else refuseUpgrade(socket, 404);
  };
}
