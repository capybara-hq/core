import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { CLIENT_API_VERSION, CLIENT_LIMITS, PLUGIN_MANIFEST_FILE } from "@capybara-hq/plugin-sdk";
import { extract } from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetPathProblem, cssRemoteProblem, PackRuleError } from "../src/pack/client.js";
import { packPlugin } from "../src/pack/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

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

const sri = (b: Buffer) => `sha384-${createHash("sha384").update(b).digest("base64")}`;

let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pack-client-"));
});
afterAll(() => rm(out, { recursive: true, force: true }));

describe("pack builds client code", () => {
  it("pack writes the client section with sha384 integrity", async () => {
    const r = await packPlugin(fixture("plugin-client-clean"), join(out, "a"));
    const entries = await readTgz(r.file);
    const client = r.manifest.extension?.client;
    expect(client?.entry).toBe("./dist/client/client.mjs");
    expect(client?.styles).toEqual(["./dist/client/styles/theme.css"]);
    expect(client?.assets).toEqual(["./dist/client/assets/click.ogg"]);
    expect(client?.apiVersion).toBe(CLIENT_API_VERSION);
    expect(r.manifest.extension?.manifest.permissions.client).toBe(true);
    const paths = [
      "./dist/client/client.mjs",
      ...(client?.styles ?? []),
      ...(client?.assets ?? []),
    ];
    expect(Object.keys(client?.integrity ?? {}).sort()).toEqual([...paths].sort());
    for (const p of paths) {
      const bytes = entries.get(p.slice(2));
      expect(bytes, p).toBeDefined();
      expect(client?.integrity[p]).toBe(sri(bytes as Buffer));
    }
    const manifest = JSON.parse((entries.get(PLUGIN_MANIFEST_FILE) as Buffer).toString("utf8"));
    expect(manifest.extension.client).toEqual(client);
  });

  it("the bundle keeps the four externals as bare imports", async () => {
    const r = await packPlugin(fixture("plugin-client-clean"), join(out, "b"));
    const code = ((await readTgz(r.file)).get("dist/client/client.mjs") as Buffer).toString("utf8");
    expect(code).toContain('from"react"');
    expect(code).toContain('from"react/jsx-runtime"');
    expect(code).toContain('from"@capybara-hq/plugin-client"');
    expect(code).not.toContain("react.production");
  });

  it("CSS is wrapped in @layer extensions", async () => {
    const r = await packPlugin(fixture("plugin-client-clean"), join(out, "c"));
    const css = ((await readTgz(r.file)).get("dist/client/styles/theme.css") as Buffer).toString();
    expect(css.startsWith("@layer extensions {\n")).toBe(true);
    expect(css.trimEnd().endsWith("}")).toBe(true);
    expect(css).toContain("--cb-bg");
  });

  it("packs reproducibly", async () => {
    const a = await packPlugin(fixture("plugin-client-clean"), join(out, "ra"));
    const b = await packPlugin(fixture("plugin-client-clean"), join(out, "rb"));
    expect(a.sha256).toBe(b.sha256);
  });

  it("pack fails without permissions.client", async () => {
    const err = await packPlugin(fixture("plugin-client-undeclared"), join(out, "u")).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PackRuleError);
    expect(err.rule).toBe("client-undeclared");
    expect(err.message).toContain("permissions.client");
  });

  it("an unresolved or Node import fails the pack", async () => {
    const err = await packPlugin(fixture("plugin-client-forbidden-import"), join(out, "f")).catch(
      (e) => e,
    );
    expect(err.rule).toBe("client-import-forbidden");
    expect(err.message).toContain("lodash-es");
    expect(err.message).toContain("node:fs");
  });

  it("an @import in CSS fails the pack", async () => {
    const err = await packPlugin(fixture("plugin-client-remote-css"), join(out, "r")).catch(
      (e) => e,
    );
    expect(err.rule).toBe("client-css-remote");
  });

  it("a suggested replacement in a list slot fails the pack", async () => {
    const err = await packPlugin(fixture("plugin-appearance-bad"), join(out, "p")).catch((e) => e);
    expect(err.rule).toBe("appearance-invalid");
    expect(err.message).toContain("conversation.panel");
  });

  describe("generated plugins", () => {
    let dir: string;
    const gen = async (): Promise<void> => {
      dir = await mkdtemp(join(tmpdir(), "pack-client-gen-"));
      await cp(fixture("plugin-client-clean"), dir, { recursive: true });
    };
    const rm2 = () => rm(dir, { recursive: true, force: true });

    const stub = async (name: string, file = "index.js", code = "export default 1;\n") => {
      const d = join(dir, "node_modules", name);
      await mkdir(d, { recursive: true });
      await writeFile(
        join(d, "package.json"),
        JSON.stringify({ name, version: "1.0.0", type: "module", main: file }),
      );
      await writeFile(join(d, file), code);
    };
    const entry = (imports: string) =>
      writeFile(join(dir, "src/client.ts"), `${imports}\nexport default 1;\n`);
    const packFor = async (imports: string, tag: string) => {
      await rm(join(dir, "src/client.tsx"));
      await entry(imports);
      return packPlugin(dir, join(out, tag)).catch((e) => e);
    };

    it.each([
      ["react-dom/server", 'import "react-dom/server";'],
      ["react-dom/client", 'import "react-dom/client";'],
      ["react/jsx-dev-runtime", 'import "react/jsx-dev-runtime";'],
      ["@capybara-hq/plugin-sdk", 'import "@capybara-hq/plugin-sdk";'],
      ["@capybara-hq/plugin-client/testing", 'import "@capybara-hq/plugin-client/testing";'],
      ["node:fs", 'import "node:fs";'],
    ])("%s is client-import-forbidden even when it resolves", async (spec, imports) => {
      await gen();
      try {
        await stub("react-dom", "index.js");
        await stub("react-dom/server", "index.js");
        await stub("react-dom/client", "index.js");
        await stub("react/jsx-dev-runtime", "index.js");
        await stub("@capybara-hq/plugin-sdk");
        await stub("@capybara-hq/plugin-client/testing");
        const err = await packFor(imports, "resolving");
        expect(err.rule).toBe("client-import-forbidden");
        expect(err.message).toContain(spec);
      } finally {
        await rm2();
      }
    });

    it("a bare builtin name is refused unless an npm package of that name resolves", async () => {
      await gen();
      try {
        const err = await packFor('import "events";', "b1");
        expect(err.rule).toBe("client-import-forbidden");
        expect(err.message).toContain("events");
        await stub("events", "index.js", "export const x = 1;\n");
        const ok = await packPlugin(dir, join(out, "b2"));
        expect(ok.manifest.extension?.client?.entry).toBe("./dist/client/client.mjs");
      } finally {
        await rm2();
      }
    });

    it("permissions.client without client code is client-undeclared", async () => {
      await gen();
      try {
        await rm(join(dir, "src/client.tsx"));
        await rm(join(dir, "client"), { recursive: true });
        const err = await packPlugin(dir, join(out, "rev")).catch((e) => e);
        expect(err).toBeInstanceOf(PackRuleError);
        expect(err.rule).toBe("client-undeclared");
        expect(err.message).toContain("no client code");
      } finally {
        await rm2();
      }
    });

    it("an entry over the limit is client-size", async () => {
      await gen();
      try {
        await writeFile(
          join(dir, "src/client.ts"),
          `export default "${"x".repeat(CLIENT_LIMITS.entryBytes + 10)}";\n`,
        );
        await rm(join(dir, "src/client.tsx"));
        const err = await packPlugin(dir, join(out, "big")).catch((e) => e);
        expect(err.rule).toBe("client-size");
      } finally {
        await rm2();
      }
    });

    it("an asset over the limit is client-size", async () => {
      await gen();
      try {
        await writeFile(
          join(dir, "client/assets/huge.wav"),
          Buffer.alloc(CLIENT_LIMITS.assetBytes + 1),
        );
        const err = await packPlugin(dir, join(out, "bigasset")).catch((e) => e);
        expect(err.rule).toBe("client-size");
      } finally {
        await rm2();
      }
    });

    it("a suggested theme the plugin does not carry is appearance-invalid", async () => {
      await gen();
      try {
        const file = join(dir, PLUGIN_MANIFEST_FILE);
        const m = JSON.parse(await readFile(file, "utf8"));
        m.suggestedAppearance = { theme: "nowhere" };
        await writeFile(file, JSON.stringify(m));
        const err = await packPlugin(dir, join(out, "theme")).catch((e) => e);
        expect(err.rule).toBe("appearance-invalid");
      } finally {
        await rm2();
      }
    });

    it("an asset path the kernel cannot look up by key fails the pack", async () => {
      await gen();
      try {
        await mkdir(join(dir, "client/assets/a"), { recursive: true });
        await writeFile(join(dir, "client/assets/a/100%.png"), "x");
        await expect(packPlugin(dir, join(out, "pct"))).rejects.toThrow(/100%\.png.*%/);
        await rm(join(dir, "client/assets/a/100%.png"));
        await writeFile(join(dir, "client/assets/a/my file.png"), "x");
        await expect(packPlugin(dir, join(out, "space"))).rejects.toThrow(/my file\.png.*letters/);
      } finally {
        await rm2();
      }
    });

    it("a url() that is not one of the plugin's assets is client-css-remote", async () => {
      await gen();
      try {
        for (const [i, u] of [
          "../../../../v1/x",
          "../../../../../plugins/x/y",
          "../assets/missing.png",
          "foo.png",
        ].entries()) {
          await writeFile(join(dir, "client/styles/theme.css"), `a { b: url(${u}); }\n`);
          const err = await packPlugin(dir, join(out, `rel${i}`)).catch((e) => e);
          expect(err.rule, u).toBe("client-css-remote");
        }
        await writeFile(
          join(dir, "client/styles/theme.css"),
          'a { b: url("../assets/click.ogg"); c: url(data:image/png;base64,AA); d: url(#m); }\n',
        );
        const ok = await packPlugin(dir, join(out, "relok"));
        expect(ok.manifest.extension?.client?.styles).toEqual(["./dist/client/styles/theme.css"]);
      } finally {
        await rm2();
      }
    });
  });
});

describe("client helpers", () => {
  it("assetPathProblem refuses %, .., an empty stem, unknown types and other characters", () => {
    expect(assetPathProblem("a/b.png")).toBeUndefined();
    expect(assetPathProblem("a/b-c_d.1.png")).toBeUndefined();
    for (const bad of ["a b.png", "a?.png", "a#.png", "café.png"]) {
      expect(assetPathProblem(bad), bad).toMatch(/letters/);
    }
    expect(assetPathProblem("a%20b.png")).toMatch(/%/);
    expect(assetPathProblem("../b.png")).toMatch(/\.\./);
    expect(assetPathProblem("a/../b.png")).toMatch(/\.\./);
    expect(assetPathProblem("a//b.png")).toBeDefined();
    expect(assetPathProblem(".png")).toMatch(/stem/);
    expect(assetPathProblem("a/.ogg")).toMatch(/stem/);
    expect(assetPathProblem("a.exe")).toMatch(/unsupported/);
  });

  it("cssRemoteProblem lets a url() name only an asset, data: or a #fragment", () => {
    const assets = new Set(["a.png", "x.png"]);
    const check = (css: string) => cssRemoteProblem(css, assets);
    expect(check('a { background: url("../assets/x.png"); }')).toBeUndefined();
    expect(check("a { background: url(../assets/a.png); }")).toBeUndefined();
    expect(check("a { background: url(data:image/png;base64,AA); }")).toBeUndefined();
    expect(check("a { mask: url(#m); }")).toBeUndefined();
    expect(check('a { b: image-set("../assets/a.png" type("image/png") 1x); }')).toBeUndefined();
    for (const u of [
      "../../../../v1/x",
      "../../../../../plugins/x/y",
      "../assets/missing.png",
      "../assets/../../x",
      "foo.png",
      "../assets/a.png?x",
    ]) {
      expect(check(`a { b: url(${u}); }`), u).toMatch(/not allowed/);
    }
    expect(check('a { b: image-set("x.png" 1x); }')).toMatch(/not allowed/);
  });

  it("cssRemoteProblem refuses @import and absolute url()", () => {
    const check = (css: string) => cssRemoteProblem(css, new Set(["a.png", "x.png"]));
    expect(check('a { background: url("../assets/x.png"); }')).toBeUndefined();
    expect(check("a { background: url(data:image/png;base64,AA); }")).toBeUndefined();
    expect(check("/* @import url(x) */ a {}")).toBeUndefined();
    expect(check('@import "x.css";')).toMatch(/@import/);
    expect(check("a { background: url(https://x.test/a.png); }")).toMatch(/url/);
    expect(check("a { background: url(//x.test/a.png); }")).toMatch(/url/);
    expect(check("a { background: url(/a.png); }")).toMatch(/url/);
    expect(check('a { background: image-set("https://x.test/a.png" 1x); }')).toMatch(/url/);
    expect(check("a { background: image-set(url(https://x.test/a.png) 1x); }")).toMatch(/url/);
    expect(check('a { background: -webkit-image-set("//x.test/a.png" 1x); }')).toMatch(/url/);
    expect(check('a { background: image-set("../assets/a.png" 1x); }')).toBeUndefined();
    expect(check("a { background: u\\72l(\\68 ttps://x.test/a.png); }")).toMatch(/url/);
    expect(check("a { background: url(\\68 ttps://x.test/a.png); }")).toMatch(/url/);
    expect(check("\\40import 'x.css';")).toMatch(/@import/);
  });
});
