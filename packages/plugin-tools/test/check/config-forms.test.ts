import { readdir } from "node:fs/promises";
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
    // plugin-config-ui is private: its org field has a label anyway, and nothing about labels is
    // reported for the deployment fields either
    const f = await checkConfigForms([fixture("plugin-config-ui")]);
    expect(f.some((x) => x.rule === "plugin-config-labels")).toBe(false);
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
