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
// Node 24 strips the types from peer.ts and object-store-proxy.ts itself, so the imports need no
// build step.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import next from "next";
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
const graceMs = shutdownGraceMs(process.env.CAPYBARA_WEB_SHUTDOWN_GRACE_MS);

// Set the marker before Next starts, so any worker processes inherit it.
const token = randomBytes(32).toString("base64url");
process.env[PEER_TOKEN_ENV] = token;

const app = next({ dev, dir: import.meta.dirname, port, ...(hostname && { hostname }) });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  if (objectStore && isObjectStorePath(objectStore, req.url ?? "/")) {
    proxyObjectStore(objectStore, req, res);
    return;
  }
  sanitizeIncoming(req, token, trust);
  handle(req, res);
}).listen(port, hostname, () => {
  console.log(
    `> web listening on http://${hostname ?? "localhost"}:${port} (${dev ? "dev" : "production"})${objectStore ? `; object storage /${objectStore.bucket}/ -> ${objectStore.upstream.origin}` : ""}`,
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
