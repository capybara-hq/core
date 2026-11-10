import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeExtensionDir, packFixture } from "../src/index.js";

interface Packed {
  list: string[];
  manifest: {
    suggestedAppearance?: { theme?: string; replacements?: Record<string, string> };
    extension?: {
      client?: { entry?: string; styles?: string[]; integrity: Record<string, string> };
      manifest: { permissions: { client?: boolean; ui?: { components?: string[] } } };
    };
  };
  read(path: string): string;
  /** The raw bytes of a file of the tgz. */
  bytes(path: string): Buffer;
}

async function pack(name: "fake-client" | "fake-client-broken"): Promise<Packed> {
  const dir = await mkdtemp(join(tmpdir(), `testing-${name}-`));
  try {
    const r = await packFixture(name, dir);
    const raw = execFileSync("tar", ["-tzf", r.file], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l !== "" && !l.endsWith("/"));
    const list = raw.map((l) => l.replace(/^\.?\/?(package\/)?/, ""));
    const read = (path: string) =>
      execFileSync("tar", ["-xzOf", r.file, raw[list.indexOf(path)] ?? ""], { encoding: "utf8" });
    const bytesOf = (path: string) =>
      execFileSync("tar", ["-xzOf", r.file, raw[list.indexOf(path)] ?? ""]);
    const client = list.filter((f) => f.startsWith("dist/client/"));
    const files = new Map(client.map((f) => [f, bytesOf(f)]));
    return {
      list,
      read: (path) => files.get(path)?.toString("utf8") ?? "",
      bytes: (path) => files.get(path) ?? Buffer.alloc(0),
      manifest: JSON.parse(read(".capybara-plugin/plugin.json")),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every integrity value of the client section is the sha384 of that file's bytes in the tgz. */
function expectIntegrity(p: Packed): void {
  const integrity = p.manifest.extension?.client?.integrity ?? {};
  expect(Object.keys(integrity).length).toBeGreaterThan(0);
  for (const [key, value] of Object.entries(integrity)) {
    const data = p.bytes(key.replace(/^\.\//, ""));
    expect(data.length, key).toBeGreaterThan(0);
    expect(value, key).toBe(`sha384-${createHash("sha384").update(data).digest("base64")}`);
  }
}

describe("client fixtures", () => {
  it("packFixture builds fake-client with a client section", async () => {
    const p = await pack("fake-client");
    const client = p.manifest.extension?.client;
    expect(client?.entry).toBe("./dist/client/client.mjs");
    expect(client?.styles).toEqual(["./dist/client/styles/fake.css"]);
    expect(Object.keys(client?.integrity ?? {}).sort()).toEqual([
      "./dist/client/client.mjs",
      "./dist/client/styles/fake.css",
    ]);
    expect(p.list).toEqual(
      expect.arrayContaining(["dist/client/client.mjs", "dist/client/styles/fake.css"]),
    );
    expect(p.list).toContain("themes/fake.json");
    expect(p.manifest.extension?.manifest.permissions.client).toBe(true);
    expect(p.manifest.extension?.manifest.permissions.ui?.components?.sort()).toEqual([
      "brand",
      "empty",
      "frame",
      "fx",
      "hud",
    ]);
    expect(p.manifest.suggestedAppearance).toEqual({
      theme: "fake",
      replacements: { "shell.brand": "brand" },
    });
    const css = p.read("dist/client/styles/fake.css");
    expect(css).toContain("@layer extensions");
    expect(css).toContain('[data-cap-part~="button.primary"]');
    expect(css).toContain('[data-cap-part~="composer"] [data-cap-part~="button"]');
    expect(css).toContain("--cx-fake-client-run: 1");
    expect(p.read("dist/client/client.mjs")).toContain("fake-client-brand");
    expectIntegrity(p);
  });

  it("fake-client-broken packs", async () => {
    const p = await pack("fake-client-broken");
    expect(p.manifest.extension?.client?.entry).toBe("./dist/client/client.mjs");
    expect(p.manifest.extension?.manifest.permissions.ui?.components?.sort()).toEqual([
      "boom",
      "empty",
    ]);
    expectIntegrity(p);
  });

  it("passes the plugin checks (capybara-plugin check)", async () => {
    const { pluginChecks } = await import("@capybara-hq/plugin-tools");
    for (const name of ["fake-client", "fake-client-broken"] as const) {
      const dir = fakeExtensionDir(name);
      for (const c of pluginChecks({ plugins: [dir], root: dir })) {
        const findings = await c.run();
        expect(findings, `${name}: ${c.name}`).toEqual([]);
      }
    }
  });
});
