// Static, read-only server for the reference set (docs/design/reference/README.md), used by
// playwright.reference.config.ts. Serves docs/design/reference/src/** at / and
// packages/design/src/{styles,fonts}/** at /design/{styles,fonts}/; everything else is 404.
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const MOUNTS = [
  ["/design/styles/", join(root, "packages/design/src/styles")],
  ["/design/fonts/", join(root, "packages/design/src/fonts")],
  ["/", join(root, "docs/design/reference/src")],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};
const PORT = Number(process.env.REFERENCE_PORT ?? 3200);

/** The file a URL path maps to, or undefined (unknown mount, `..`, or an unservable type). */
function resolvePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return undefined;
  for (const [prefix, dir] of MOUNTS) {
    if (!decoded.startsWith(prefix)) continue;
    const rel = decoded.slice(prefix.length) || "index.html";
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir + sep)) return undefined;
    return TYPES[extname(file)] ? file : undefined;
  }
  return undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const file =
    req.method === "GET" || req.method === "HEAD" ? resolvePath(url.pathname) : undefined;
  if (file === undefined || !(await stat(file).catch(() => null))?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const body = await readFile(file);
  res
    .writeHead(200, { "content-type": TYPES[extname(file)], "cache-control": "no-store" })
    .end(req.method === "HEAD" ? undefined : body);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`reference set on http://127.0.0.1:${PORT}/index.html`);
});
