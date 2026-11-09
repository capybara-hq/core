import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A web build id as the generator writes it: the package version, `-`, 12 hex digits. */
const BUILD_RE = /^[0-9A-Za-z.+-]{1,64}-[0-9a-f]{12}$/;

/**
 * The client host shims of this web build (`scripts/gen-client-host.mjs` writes
 * `public/_capybara/client-host/manifest.json` at dev / build): their build id, or null when they
 * were not generated (then the layout loads no client entry; plugin stylesheets still apply).
 * Read from the app directory (`process.cwd()` for `next dev` / `next start` / server.mjs).
 */
export async function clientHostBuild(): Promise<string | null> {
  try {
    const raw = await readFile(
      join(process.cwd(), "public", "_capybara", "client-host", "manifest.json"),
      "utf8",
    );
    const build = (JSON.parse(raw) as { build?: unknown }).build;
    return typeof build === "string" && BUILD_RE.test(build) ? build : null;
  } catch {
    return null;
  }
}
