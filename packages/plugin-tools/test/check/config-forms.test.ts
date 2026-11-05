import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkConfigForms } from "../../src/check/config-forms.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const testFixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));

const summary = (f: Awaited<ReturnType<typeof checkConfigForms>>) =>
  f.map((x) => [x.rule, x.message]);

describe("checkConfigForms", () => {
  it("plugin-config-ui: reports validateConfigUi problems and value hints on a secret", async () => {
    const f = await checkConfigForms([fixture("plugin-config-ui")]);
    expect(f.every((x) => x.rule === "plugin-config-ui")).toBe(true);
    expect(f.every((x) => /plugin-config-ui[/\\]src[/\\]index\.ts$/.test(x.file))).toBe(true);
    expect(summary(f)).toEqual([
      ["plugin-config-ui", expect.stringMatching(/^deployment config: mode: widget "switch"/)],
      [
        "plugin-config-ui",
        expect.stringMatching(/^deployment config: token: x-ui\.options .*secret/),
      ],
    ]);
  }, 60_000);

  it("plugin-config-labels: reports rendered fields of a public plugin without a zh + en label", async () => {
    const f = await checkConfigForms([fixture("plugin-config-labels")]);
    expect(summary(f)).toEqual([
      [
        "plugin-config-labels",
        expect.stringMatching(/^deployment config: endpoints\.items\.url has no label/),
      ],
      ["plugin-config-labels", expect.stringMatching(/^deployment config: timeout has no label/)],
      ["plugin-config-labels", expect.stringMatching(/^org config: region has no label/)],
    ]);
    // apiKeys is a secret record drawn per endpoint (x-ui.secrets): never reported
    expect(f.some((x) => x.message.includes("apiKeys"))).toBe(false);
  }, 60_000);

  it("a private plugin needs no labels", async () => {
    // the same extension as plugin-config-labels (unlabelled fields), in a private package
    expect(await checkConfigForms([fixture("plugin-config-labels-private")])).toEqual([]);
  }, 60_000);

  it("a malformed package.json is left to Plugin pack", async () => {
    const dir = await mkdtemp(join(fixture("."), ".tmp-bad-pkg-"));
    try {
      await cp(fixture("plugin-config-labels/src"), join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "package.json"), "{ not json");
      // esbuild cannot bundle next to a malformed package.json: no finding here, no crash
      expect(await checkConfigForms([dir])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("valid, labelled hints pass; plugins without an extension or config are skipped", async () => {
    expect(
      await checkConfigForms([
        testFixture("config-hints"),
        testFixture("declarative"),
        fixture("plugin-clean"),
      ]),
    ).toEqual([]);
  }, 60_000);

  it("leaves no temporary files in the plugin dir", async () => {
    await checkConfigForms([fixture("plugin-config-ui")]);
    expect((await readdir(fixture("plugin-config-ui"))).sort()).toEqual([
      ".capybara-plugin",
      "package.json",
      "src",
    ]);
  }, 60_000);

  it("model-fake passes", async () => {
    expect(await checkConfigForms([`${repo}plugins/model-fake`])).toEqual([]);
  }, 60_000);
});
