import { readFileSync } from "node:fs";
import { type PluginManifest, SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { PluginPackageError, readPluginPackage } from "../../src/catalog/plugin-package.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { mcpTemplate, templateFiles } from "./packages.js";

// Setup guides v2 at import (spec 2026-11-09-setup-guides-v2-design.md §4.5): the package reader
// runs the SDK validator over every guide; a guide that fails it fails the import with
// catalog.invalid_manifest naming the guide, except for an unknown variable (a plugin written for a
// newer kernel still imports, the variable stays as written).

const DOCS = new URL("../fixtures/plugins/guide-demo/guides/", import.meta.url);
const EN = readFileSync(new URL("demo.md", DOCS), "utf8");
const ZH = readFileSync(new URL("demo.zh.md", DOCS), "utf8");

const read = async (o: {
  guides?: unknown[];
  files?: Record<string, string>;
  extension?: boolean;
  manifest?: Partial<PluginManifest>;
}) =>
  readPluginPackage(
    await pluginTgz({
      manifest: {
        name: "im-guide",
        setupGuides: (o.guides ?? [{ id: "demo", place: "channel-connection" }]) as never,
        ...o.manifest,
      },
      files: o.files ?? { "guides/demo.md": EN, "guides/demo.zh.md": ZH },
      ...(o.extension !== false && { extension: { manifest: { provides: ["channel@1"] } } }),
    }),
    { maxBytes: 1 << 22, hostSdkVersion: SDK_VERSION },
  );

/** The issues of a refused package (fails when it is accepted). */
const issuesOf = async (p: Promise<unknown>): Promise<string[]> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PluginPackageError);
  expect((e as PluginPackageError).code).toBe("catalog.invalid_manifest");
  return (e as PluginPackageError).issues;
};

describe("setup guides v2 at import", () => {
  it("accepts the demo guide in both languages", async () => {
    const pkg = await read({});
    expect(pkg.manifest.setupGuides).toEqual([{ id: "demo", place: "channel-connection" }]);
  });

  it("import refuses an invalid guide with catalog.invalid_manifest naming it", async () => {
    // the zh document's manifest differs from the English one
    const drift = await issuesOf(
      read({
        files: {
          "guides/demo.md": EN,
          "guides/demo.zh.md": ZH.replace("socket_mode_enabled: true", "socket_mode_enabled: no"),
        },
      }),
    );
    expect(drift).toEqual([
      expect.stringMatching(
        /^setupGuides\.0 \(demo\): guides\/demo\.zh\.md: code block 1 \("应用 manifest（长连接）"\) differs from guides\/demo\.md block 1 at line 4; code blocks must be identical in every language$/,
      ),
    ]);
    // no level-1 title
    const untitled = await issuesOf(
      read({ files: { "guides/demo.md": EN.replace("# Create the demo app", "Intro") } }),
    );
    expect(untitled.join("\n")).toMatch(/setupGuides\.0 \(demo\): guides\/demo\.md.*level-1/);
    // an unknown mode for the place
    const mode = await issuesOf(
      read({ files: { "guides/demo.md": EN.replaceAll("::: mode webhook", "::: mode polling") } }),
    );
    expect(mode.join("\n")).toContain("polling");
    // the English document is missing; a private-use character
    const missing = await issuesOf(read({ files: { "guides/demo.zh.md": ZH } }));
    expect(missing.join("\n")).toContain("guides/demo.md not found in the package");
    const privateUse = await issuesOf(read({ files: { "guides/demo.md": `${EN}\n\n` } }));
    expect(privateUse.join("\n")).toContain("private-use");
  });

  it("import accepts an unknown variable", async () => {
    const files = {
      "guides/demo.md": EN.replace("Paste the bot token", "Paste {{clientId}} and the bot token"),
      "guides/demo.zh.md": ZH,
    };
    const pkg = await read({ files });
    expect(pkg.manifest.setupGuides).toHaveLength(1);
  });

  it("a channel guide needs a channel extension; a template guide its template", async () => {
    const noExtension = await issuesOf(
      read({
        extension: false,
        files: {
          "guides/demo.md": EN,
          ...templateFiles("github-mcp", mcpTemplate()),
        },
      }),
    );
    expect(noExtension.join("\n")).toContain("needs the plugin's extension to provide channel@1");
    const noTemplate = await issuesOf(
      read({
        extension: false,
        guides: [{ id: "gh", place: "connector-template", template: "gitlab" }],
        files: {
          "guides/gh.md": "# Set up\n\nText.\n",
          ...templateFiles("github-mcp", mcpTemplate()),
        },
      }),
    );
    expect(noTemplate.join("\n")).toContain(
      "template gitlab is not one of the plugin's connector templates",
    );
  });
});
