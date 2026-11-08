// Custom server for the web tier (`pnpm dev` / `pnpm start`).
// It exists to hand the kernel the real client address: Next's route handlers can't see the
// socket address, and Next only fills in `x-forwarded-for` when the client didn't send one.
// Before each request reaches Next, this server strips every client-supplied forwarding header,
// sets `x-forwarded-for` to the socket's peer address, and adds a random marker that only this
// process knows. The /api proxy route forwards that address only when the marker matches.
// Details: src/lib/peer.ts. Run the kernel with `http.trustProxy: 1` behind this tier.
// Behind a TLS proxy / load balancer, set CAPYBARA_WEB_TRUST_PROXY (hop count or IPs / CIDRs) so the
// client address is taken from that proxy's x-forwarded-for instead of the proxy's own address.
//
// With CAPYBARA_WEB_OBJECT_STORE_URL set, it also proxies the object-store bucket path
// (/<bucket>/**) so browsers upload and download attachments on the web origin; that path never
// reaches Next. Details: src/lib/object-store-proxy.ts.
//
// With CAPYBARA_WEB_GATEWAY_URL set, WebSocket upgrades on exactly /device/connect (connected
// machines, `capybara-device`) are piped to a gateway replica; any other upgrade path is refused
// (dev: handed to Next's HMR). Details: src/lib/device-connect-proxy.ts.
//
// Idle keep-alive connections stay open for CAPYBARA_WEB_KEEP_ALIVE_TIMEOUT_MS (default 65 s), longer
// than a load balancer in front keeps them, so the proxy closes first instead of reusing a
// connection this server is closing. Details: src/lib/keep-alive.ts.
//
// Node 24 strips the types from peer.ts, object-store-proxy.ts, device-connect-proxy.ts and
// keep-alive.ts itself, so the imports need no build step.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import next from "next";
import { handleUpgrade, parseGatewayProxy } from "./src/lib/device-connect-proxy.ts";
import { applyKeepAlive, KEEP_ALIVE_ENV, parseKeepAliveTimeout } from "./src/lib/keep-alive.ts";
import {
  isObjectStorePath,
  parseObjectStoreProxy,
  proxyObjectStore,
} from "./src/lib/object-store-proxy.ts";
import {
  PEER_TOKEN_ENV,
  parseTrustProxy,
  sanitizeIncoming,
  TRUST_PROXY_ENV,
} from "./src/lib/peer.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.CAPYBARA_WEB_HOST;
// Parsed once at startup; a malformed value stops the server here.
const trust = parseTrustProxy(process.env[TRUST_PROXY_ENV]);
// Off (undefined) unless CAPYBARA_WEB_OBJECT_STORE_URL is set; a malformed setting stops here too.
const objectStore = parseObjectStoreProxy(process.env);
// Off (undefined) unless CAPYBARA_WEB_GATEWAY_URL is set; a malformed setting stops here too.
const gateway = parseGatewayProxy(process.env);
const graceMs = shutdownGraceMs(process.env.CAPYBARA_WEB_SHUTDOWN_GRACE_MS);
// A malformed value stops the server here too.
const keepAliveMs = parseKeepAliveTimeout(process.env[KEEP_ALIVE_ENV]);

// Set the marker before Next starts, so any worker processes inherit it.
const token = randomBytes(32).toString("base64url");
process.env[PEER_TOKEN_ENV] = token;

// Next attaches its own upgrade listener (dev HMR) to `httpServer`; this emitter receives only the
// upgrades handleUpgrade hands on, so Next never sees (or ends) a /device/connect socket.
const nextUpgrades = new EventEmitter();
const app = next({
  dev,
  dir: import.meta.dirname,
  port,
  httpServer: nextUpgrades,
  ...(hostname && { hostname }),
});
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  // The container health check (docker/web.Dockerfile): this tier answers, without Next or the
  // kernel, so the check never depends on the deployment's state (a fresh one redirects /login).
  if (req.url === "/healthz") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("ok");
    return;
  }
  if (objectStore && isObjectStorePath(objectStore, req.url ?? "/")) {
    proxyObjectStore(objectStore, req, res);
    return;
  }
  sanitizeIncoming(req, token, trust);
  handle(req, res);
});
server.on(
  "upgrade",
  handleUpgrade(
    gateway,
    dev ? (req, socket, head) => nextUpgrades.emit("upgrade", req, socket, head) : undefined,
  ),
);
applyKeepAlive(server, keepAliveMs);
server.listen(port, hostname, () => {
  console.log(
    `> web listening on http://${hostname ?? "localhost"}:${port} (${dev ? "dev" : "production"})${objectStore ? `; object storage /${objectStore.bucket}/ -> ${objectStore.upstream.origin}` : ""}${gateway ? `; /device/connect -> ${gateway.upstream.origin}` : ""}`,
  );
});

// In production (e.g. as PID 1 in a container, where node has no default signal handling) stop on
// SIGTERM / SIGINT: refuse new connections, give in-flight requests CAPYBARA_WEB_SHUTDOWN_GRACE_MS
// (SSE streams never end by themselves), then exit. Dev keeps Node's default: exit at once.
if (!dev) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), graceMs).unref();
    });
  }
}

/** CAPYBARA_WEB_SHUTDOWN_GRACE_MS: a non-negative integer; unset or invalid means 5000. */
function shutdownGraceMs(raw) {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : 5000;
}
