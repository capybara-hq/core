import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A web build id as the generator writes it: the package version, `-`, 12 hex digits. */
const BUILD_RE = /^[0-9A-Za-z.+-]{1,64}-[0-9a-f]{12}$/;
const INTEGRITY_RE = /^sha384-[A-Za-z0-9+/]{64}$/;

/** The shim files of a build (`scripts/gen-client-host.mjs`). */
export const CLIENT_HOST_FILES = [
  "react.mjs",
  "react-jsx-runtime.mjs",
  "react-dom.mjs",
  "plugin-client.mjs",
] as const;

/** The client host shims of this web build: their build id and each file's sha384. */
export interface ClientHostInfo {
  build: string;
  integrity: Record<(typeof CLIENT_HOST_FILES)[number], string>;
}

let warned = false;

/**
 * The client host shims of this web build (`scripts/gen-client-host.mjs` writes
 * `public/_capybara/client-host/manifest.json` at dev / build), or null when they were not
 * generated or the manifest is malformed: then the layout loads no client entry (plugin stylesheets
 * still apply), and the server says so once. Read from the app directory (`process.cwd()` for
 * `next dev` / `next start` / server.mjs).
 */
export async function clientHost(): Promise<ClientHostInfo | null> {
  const path = join(process.cwd(), "public", "_capybara", "client-host", "manifest.json");
  try {
    const m = JSON.parse(await readFile(path, "utf8")) as { build?: unknown; integrity?: unknown };
    const integrity = (m.integrity ?? {}) as Record<string, unknown>;
    if (
      typeof m.build === "string" &&
      BUILD_RE.test(m.build) &&
      CLIENT_HOST_FILES.every(
        (f) => typeof integrity[f] === "string" && INTEGRITY_RE.test(integrity[f]),
      )
    ) {
      return { build: m.build, integrity: integrity as ClientHostInfo["integrity"] };
    }
    throw new Error("malformed manifest");
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(
        `client extensions: no client host shims at ${path} (${(e as Error).message}); ` +
          "client entries will not load. Run `pnpm --filter @capybara-hq/web gen:client-host`.",
      );
    }
    return null;
  }
}
