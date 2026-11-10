import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_API_VERSION, CLIENT_LIMITS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { clientApiVersionFindings, clientFindings } from "../src/check/client.js";
import { checkPluginPack } from "../src/check/plugin-pack.js";
import { clientStyleNames } from "../src/pack/client.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const errorsOf = <T extends { severity?: string }>(f: T[]) =>
  f.filter((x) => x.severity !== "warning");
const rules = (f: { rule: string }[]) => f.map((x) => x.rule);

describe("client findings of check", () => {
  it("a clean client plugin has no findings", async () => {
    expect(await checkPluginPack([fixture("plugin-client-clean")])).toEqual([]);
  });

  it.each([
    ["plugin-client-forbidden-import", "client-import-forbidden"],
    ["plugin-client-remote-css", "client-css-remote"],
    ["plugin-client-undeclared", "client-undeclared"],
    ["plugin-appearance-bad", "appearance-invalid"],
  ])("%s yields exactly %s", async (name, rule) => {
    const f = await checkPluginPack([fixture(name)]);
    expect(rules(f)).toEqual([rule]);
    expect(f[0]?.severity).toBeUndefined();
    expect(f[0]?.file).toMatch(new RegExp(`${name}[/\\\\]package\\.json$`));
  });

  it("an entry over the limit yields exactly client-size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-client-big-"));
    try {
      await cp(fixture("plugin-client-clean"), dir, { recursive: true });
      await rm(join(dir, "src/client.tsx"));
      await writeFile(
        join(dir, "src/client.ts"),
        `export default "${"x".repeat(CLIENT_LIMITS.entryBytes + 10)}";\n`,
      );
      expect(rules(await checkPluginPack([dir]))).toEqual(["client-size"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a selector not built from parts, states or own classes is only a warning", async () => {
    const f = await checkPluginPack([fixture("plugin-client-selector")]);
    expect(rules(f)).toEqual(["client-css-selector"]);
    expect(f[0]?.severity).toBe("warning");
    expect(f[0]?.message).toContain(".cb-sidebar");
    expect(errorsOf(f)).toEqual([]);
  });

  it("client-api-version flags a section built for another API", () => {
    const section = { integrity: {}, apiVersion: CLIENT_API_VERSION + 1 };
    expect(rules(clientApiVersionFindings("p.json", section))).toEqual(["client-api-version"]);
    expect(
      clientApiVersionFindings("p.json", { ...section, apiVersion: CLIENT_API_VERSION }),
    ).toEqual([]);
    expect(clientApiVersionFindings("p.json", undefined)).toEqual([]);
  });

  describe("clientFindings", () => {
    const scan = async (css: string, parts?: string[]) => {
      const dir = await mkdtemp(join(tmpdir(), "check-client-css-"));
      try {
        await cp(fixture("plugin-client-clean"), dir, { recursive: true });
        await writeFile(join(dir, "client/styles/theme.css"), css);
        return clientFindings(dir, await clientStyleNames(dir), "p", parts);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it("accepts parts, states, own classes, :root cx variables and at-rules", async () => {
      const css = `
:root { --cx-p-a: 1; }
@media (min-width: 1px) { [data-cap-part~="shell"] .cx-p-x { color: var(--cb-fg); } }
@keyframes spin { from { opacity: 0; } 50% { opacity: .5; } to { opacity: 1; } }
@font-face { font-family: X; src: url("../assets/a.woff2"); }
[data-cap-part="a"][data-cap-state~="b"], .cx-p-y > span { content: "}{"; }`;
      expect(await scan(css, ["shell", "a"])).toEqual([]);
    });

    it("warns on foreign classes, ids, bare tags and foreign :root variables", async () => {
      const f = await scan(
        `.x { a: b; }\n#id [data-cap-part] { a: b; }\ndiv a { a: b; }\n:root { --other: 1; }`,
      );
      expect(rules(f)).toEqual([
        "client-css-selector",
        "client-css-selector",
        "client-css-selector",
        "client-css-selector",
      ]);
      expect(f.map((x) => x.line)).toEqual([1, 2, 3, 4]);
    });

    it("a foreign class next to an attribute selector still warns", async () => {
      const f = (
        await scan(
          '.foo[data-cap-part~="shell"] { a: b; }\n[data-a] .bar { a: b; }\n[data-cap-part~="shell"].baz { a: b; }',
        )
      ).filter((x) => x.rule === "client-css-selector");
      expect(rules(f)).toEqual([
        "client-css-selector",
        "client-css-selector",
        "client-css-selector",
      ]);
      expect(f.map((x) => x.message)).toEqual([
        expect.stringContaining(".foo"),
        expect.stringContaining(".bar"),
        expect.stringContaining(".baz"),
      ]);
    });

    it("ui-part-unknown names a part the host does not know", async () => {
      const css = '[data-cap-part~="sidebar"] { a: b; }\n[data-cap-part~="nope shell"] { a: b; }';
      const f = await scan(css, ["sidebar", "shell"]);
      expect(rules(f)).toEqual(["ui-part-unknown"]);
      expect(f[0]?.message).toContain('"nope"');
      expect(f[0]?.severity).toBe("warning");
    });

    it("ui-part-unknown defaults to the SDK catalog and is silent with no known parts", async () => {
      expect(await scan('[data-cap-part~="anything"] { a: b; }', [])).toEqual([]);
      expect(rules(await scan('[data-cap-part~="anything"] { a: b; }'))).toEqual([
        "ui-part-unknown",
      ]);
      expect(await scan('[data-cap-part~="button.primary"] { a: b; }')).toEqual([]);
    });
  });

  it("leaves the fixture untouched", async () => {
    await checkPluginPack([fixture("plugin-client-clean")]);
    expect(
      JSON.parse(await readFile(join(fixture("plugin-client-clean"), "package.json"), "utf8")).name,
    ).toContain("plugin-client-clean");
  });
});
