/**
 * Connected machines on the web origin (server.mjs only; erasable TypeScript syntax only, so Node's
 * type stripping can import it directly, like peer.ts).
 *
 * `capybara-device` opens its WebSocket at `<http.publicUrl>/device/connect`, and the public URL is
 * the web origin. The kernel serves that route only on the `gateway` role, which compose does not
 * publish, so this server forwards WebSocket upgrades whose path is exactly `/device/connect` to a
 * gateway replica (CAPYBARA_WEB_GATEWAY_URL, an http(s) URL):
 *
 * - The raw socket is piped: the original request line and headers (Authorization,
 *   X-Capybara-Device-Protocol, the WebSocket handshake) go to the gateway, then any bytes the
 *   client already sent, then both directions stream untouched. The gateway answers the handshake
 *   (101, or 401 / 426 with JSON) itself.
 * - `Host` is the gateway's; forwarding headers, cookies and this server's peer marker are not sent
 *   (the gateway trusts no forwarding header).
 * - An error on either side destroys both sockets; a gateway that can't be reached gets 502.
 * - The gateway is CAPYBARA_WEB_GATEWAY_URL, else the kernel at CAPYBARA_KERNEL_URL.
 *
 * An external proxy may route `/device/connect` to the gateway replicas directly instead; then
 * these upgrades never reach this server.
 */

import type { IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

export const GATEWAY_URL_ENV = "CAPYBARA_WEB_GATEWAY_URL";
export const DEVICE_CONNECT_PATH = "/device/connect";

export interface GatewayProxy {
  /** Gateway origin, e.g. http://gateway:8080. */
  upstream: URL;
}

/** Request headers never forwarded (forwarding, cookies, proxy credentials, our marker, the host). */
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
 * The gateway web forwards /device/connect to: CAPYBARA_WEB_GATEWAY_URL, else the kernel web already
 * talks to (CAPYBARA_KERNEL_URL, default http://localhost:8080), which runs every role unless the
 * deployment splits them (then CAPYBARA_WEB_GATEWAY_URL names a gateway replica, as compose does).
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

/** Whether a request target's path (query ignored) is exactly `/device/connect`. */
export function isDeviceConnectPath(target: string | undefined): boolean {
  return (target ?? "").split("?")[0] === DEVICE_CONNECT_PATH;
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
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
}

export type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * The server's one `upgrade` listener: `/device/connect` goes to the gateway; any other path goes
 * to `other` when given (dev: Next's HMR socket) and is refused with 404 otherwise.
 */
export function handleUpgrade(cfg: GatewayProxy, other?: UpgradeListener): UpgradeListener {
  return (req, socket, head) => {
    if (isDeviceConnectPath(req.url)) proxyDeviceConnect(cfg, req, socket, head);
    else if (other) other(req, socket, head);
    else refuseUpgrade(socket, 404);
  };
}
