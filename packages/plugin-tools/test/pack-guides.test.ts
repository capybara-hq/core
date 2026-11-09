import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readPluginPackage } from "@capybara-hq/kernel";
import { PLUGIN_MANIFEST_FILE, parsePluginManifest, SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { extract } from "tar-stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkPluginPack } from "../src/check/plugin-pack.js";
import { packPlugin } from "../src/pack/index.js";

// Setup guides v2 (spec 2026-11-09-setup-guides-v2-design.md §4): pack ships guides/<id>.md and
// guides/<id>.zh.md and runs the SDK validator; errors fail, warnings are returned and printed.

const F = "```";
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

async function readTgz(file: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const ex = extract();
  const done = (async () => {
    for await (const e of ex) {
      const chunks: Buffer[] = [];
      for await (const c of e) chunks.push(c as Buffer);
      entries.set(e.header.name.replace(/^package\//, ""), Buffer.concat(chunks));
    }
  })();
  ex.end(gunzipSync(await readFile(file)));
  await done;
  return entries;
}

let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pack-guides-"));
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("packPlugin: setup guides v2 with an extension", () => {
  it("pack ships guides/<id>.md and .zh.md", async () => {
    const r = await packPlugin(fixture("guides-channel"), out);
    const entries = await readTgz(r.file);
    expect(entries.get("guides/app.md")?.toString("utf8")).toBe(
      await readFile(join(fixture("guides-channel"), "guides/app.md"), "utf8"),
    );
    expect(entries.has("guides/app.zh.md")).toBe(true);
    const m = parsePluginManifest(entries.get(PLUGIN_MANIFEST_FILE)?.toString("utf8"));
    if ("errors" in m) throw new Error(m.errors.join("; "));
    expect(m.setupGuides).toEqual([{ id: "app", place: "channel-connection" }]);
    const pkg = await readPluginPackage(new Uint8Array(await readFile(r.file)), {
      maxBytes: 20 * 1024 * 1024,
      hostSdkVersion: SDK_VERSION,
    });
    expect(pkg.manifest.setupGuides).toHaveLength(1);
  }, 60_000);

  it("pack warns on a text variable in a sh fence", async () => {
    const r = await packPlugin(fixture("guides-channel"), out);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(
      /^@capybara-hq\/plugin-fixture-guides-channel: setupGuides app: guides\/app\.md:\d+: the text variable \{\{connectionName\}\} in a sh code block is not quoted/,
    );
    expect(r.warnings[1]).toMatch(/guides\/app\.zh\.md:\d+: the text variable/);
  }, 60_000);

  it("check reports the warnings without failing", async () => {
    const f = await checkPluginPack([fixture("guides-channel")]);
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["plugin-pack-guide", "warning"],
      ["plugin-pack-guide", "warning"],
    ]);
    expect(f[0]?.message).toMatch(/setupGuides app: guides\/app\.md:\d+: the text variable/);
  }, 60_000);

  it("pack fails when a check id is not in permissions.setupChecks", async () => {
    await expect(packPlugin(fixture("guides-undeclared-check"), out)).rejects.toThrow(
      /setupGuides app: guides\/app\.md:3: check bot-token is not declared in the extension's permissions\.setupChecks/,
    );
    const f = await checkPluginPack([fixture("guides-undeclared-check")]);
    expect(f.map((x) => x.rule)).toEqual(["plugin-pack"]);
    expect(f[0]?.severity).toBeUndefined();
  }, 60_000);

  it("fake-im ships its guide and the packed plugin passes the kernel's reader", async () => {
    const r = await packPlugin(join(repo, "packages/testing/fixtures/extensions/fake-im"), out);
    const entries = await readTgz(r.file);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining(["guides/fake-im-app.md", "guides/fake-im-app.zh.md"]),
    );
    expect([...entries.keys()].filter((k) => k.endsWith(".tmpl"))).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.manifest.setupGuides).toEqual([{ id: "fake-im-app", place: "channel-connection" }]);
    await readPluginPackage(new Uint8Array(await readFile(r.file)), {
      maxBytes: 20 * 1024 * 1024,
      hostSdkVersion: SDK_VERSION,
    });
  }, 60_000);
});

describe("packPlugin: setup guides v2 without an extension", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pack-guides-src-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "@x/plugin-guides", version: "0.1.0", type: "module" }),
    );
    await mkdir(join(dir, "connectors"));
    await writeFile(
      join(dir, "connectors/x.json"),
      await readFile(join(fixture("declarative"), "connectors/x.json")),
    );
    await mkdir(join(dir, ".capybara-plugin"));
    await writeFile(
      join(dir, PLUGIN_MANIFEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        name: "guides",
        version: "0.1.0",
        publisher: "Capybara",
        description: "Guide tests",
        connectorTemplates: [{ path: "./connectors/x.json" }],
        setupGuides: [{ id: "x-setup", place: "connector-template", template: "x" }],
      }),
    );
    await mkdir(join(dir, "guides"));
    return () => rm(dir, { recursive: true, force: true });
  });
  const guide = (name: string, text: string) => writeFile(join(dir, "guides", name), text);
  const en = (code: string, extra = "") =>
    [
      "# Connect X",
      "",
      `${F}yaml title="First"`,
      "a: 1",
      F,
      "",
      `${F}yaml title="Second"`,
      code,
      F,
      extra,
      "",
    ].join("\n");

  it("ships a connector-template guide without zh", async () => {
    await guide("x-setup.md", en("b: 2", "::check capybara:public-url Public URL"));
    const r = await packPlugin(dir, out);
    const entries = await readTgz(r.file);
    expect(entries.has("guides/x-setup.md")).toBe(true);
    expect(entries.has("guides/x-setup.zh.md")).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("pack fails on a missing English document", async () => {
    await guide("x-setup.zh.md", en("b: 2"));
    await expect(packPlugin(dir, out)).rejects.toThrow(
      "@x/plugin-guides: setupGuides x-setup: guides/x-setup.md does not exist (each guide needs its English document)",
    );
  });

  it("pack fails on zh code block drift with the exact message", async () => {
    await guide("x-setup.md", en("b: 2\nc: 3"));
    await guide("x-setup.zh.md", en("b: 2\nc: 4").replace("# Connect X", "# 连接 X"));
    await expect(packPlugin(dir, out)).rejects.toThrow(
      'guides/x-setup.zh.md: code block 2 ("Second") differs from guides/x-setup.md block 2 at line 2; code blocks must be identical in every language',
    );
  });

  it("pack fails on an unknown variable", async () => {
    await guide("x-setup.md", en('b: "{{appSecret}}"'));
    await expect(packPlugin(dir, out)).rejects.toThrow(
      /setupGuides x-setup: guides\/x-setup\.md:\d+: unknown variable \{\{appSecret\}\} for place connector-template/,
    );
  });

  it("pack fails on a private-use character in a document", async () => {
    await guide("x-setup.md", en("b: "));
    await expect(packPlugin(dir, out)).rejects.toThrow(
      /setupGuides x-setup: guides\/x-setup\.md contains a private-use character/,
    );
  });

  it("fails on a plugin check without an extension", async () => {
    await guide("x-setup.md", en("b: 2", "::check bot-token Bot token works"));
    await expect(packPlugin(dir, out)).rejects.toThrow(
      /setupGuides x-setup: guides\/x-setup\.md:\d+: check bot-token needs the plugin's extension/,
    );
  });
});
