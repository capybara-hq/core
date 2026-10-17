// Custom server for the web tier (`pnpm dev` / `pnpm start`).
// It exists to hand the kernel the real client address: Next's route handlers can't see the
// socket address, and Next only fills in `x-forwarded-for` when the client didn't send one.
// Before each request reaches Next, this server strips every client-supplied forwarding header,
// sets `x-forwarded-for` to the socket's peer address, and adds a random marker that only this
// process knows. The /api proxy route forwards that address only when the marker matches.
// Details: src/lib/peer.ts. Run the kernel with `http.trustProxy: 1` behind this tier.
//
// Node 24 strips the types from peer.ts itself, so the import needs no build step.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import next from "next";
import { PEER_TOKEN_ENV, sanitizeIncoming } from "./src/lib/peer.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.CAPYBARA_WEB_HOST;

// Set the marker before Next starts, so any worker processes inherit it.
const token = randomBytes(32).toString("base64url");
process.env[PEER_TOKEN_ENV] = token;

const app = next({ dev, dir: import.meta.dirname, port, ...(hostname && { hostname }) });
const handle = app.getRequestHandler();
await app.prepare();

createServer((req, res) => {
  sanitizeIncoming(req, token);
  handle(req, res);
}).listen(port, hostname, () => {
  console.log(
    `> web listening on http://${hostname ?? "localhost"}:${port} (${dev ? "dev" : "production"})`,
  );
});
