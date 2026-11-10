// Client extensions spec §9.4: the client host shims re-export, by name, from the host global and
// throw without it; their build id is the web version plus a hash of their contents.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { PLUGIN_CLIENT_EXPORTS } from "../src/lib/client-host/api.generated";
import { clientHost } from "../src/lib/server/client-host";

vi.mock("server-only", () => ({}));

const SCRIPT = join(import.meta.dirname, "..", "scripts", "gen-client-host.mjs");
const dir = mkdtempSync(join(tmpdir(), "cap-client-host-"));
const out = join(dir, "public", "_capybara", "client-host");
const generate = () => execFileSync(process.execPath, [SCRIPT, "--out", out], { encoding: "utf8" });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__;
});

describe("gen-client-host", () => {
  generate();
  const { build } = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
    build: string;
  };
  const file = (name: string) => pathToFileURL(join(out, build, name)).href;

  it("writes the four shims under <version>-<sha256-12>, deterministically", () => {
    expect(build).toMatch(new RegExp(`^${pkg.version.replace(/\./g, "\\.")}-[0-9a-f]{12}$`));
    expect(readdirSync(join(out, build)).sort()).toEqual([
      "plugin-client.mjs",
      "react-dom.mjs",
      "react-jsx-runtime.mjs",
      "react.mjs",
    ]);
    generate();
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).build).toBe(build);
    // only the current build's folder is kept
    expect(readdirSync(out).sort()).toEqual([build, "manifest.json"].sort());
  });

  it("a shim throws when the host global is absent", async () => {
    await expect(import(/* @vite-ignore */ file("react.mjs"))).rejects.toThrow(
      "capybara client host not ready",
    );
  });

  it("a shim re-exports the host's members by name", async () => {
    const pluginClient = Object.fromEntries(PLUGIN_CLIENT_EXPORTS.map((n) => [n, `pc:${n}`]));
    const jsxRuntime = { jsx: "J", jsxs: "JS", Fragment: "F" };
    (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__ = { pluginClient, jsxRuntime };
    const pc = (await import(/* @vite-ignore */ file("plugin-client.mjs"))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(pc).sort()).toEqual([...PLUGIN_CLIENT_EXPORTS]);
    expect(pc.useRunState).toBe("pc:useRunState");
    const jr = (await import(/* @vite-ignore */ file("react-jsx-runtime.mjs"))) as Record<
      string,
      unknown
    >;
    expect(jr).toMatchObject(jsxRuntime);
  });

  it("the layout reads the build id from the manifest; none without it", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = await clientHost();
    expect(info?.build).toBe(build);
    // each shim's sha384, from its bytes
    for (const name of [
      "react.mjs",
      "react-jsx-runtime.mjs",
      "react-dom.mjs",
      "plugin-client.mjs",
    ]) {
      const bytes = readFileSync(join(out, build, name));
      expect(info?.integrity[name as keyof NonNullable<typeof info>["integrity"]]).toBe(
        `sha384-${createHash("sha384").update(bytes).digest("base64")}`,
      );
    }
    expect(warn).not.toHaveBeenCalled();
    cwd.mockReturnValue(join(dir, "missing"));
    expect(await clientHost()).toBeNull();
    // the server says once that client entries will not load
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("gen:client-host");
    await clientHost();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    cwd.mockRestore();
  });
});
