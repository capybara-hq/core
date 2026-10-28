import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginReleaseMetadata } from "../src/check/release-metadata.js";
import { discoverPlugins } from "../src/discover.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/release-metadata/${name}`, import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const run = (root: string) => checkPluginReleaseMetadata(discoverPlugins(root), root);

describe("plugin-release-metadata", () => {
  it("passes when published plugins carry their metadata and the examples are private", () => {
    expect(run(fixture("clean"))).toEqual([]);
  });

  it("reports public examples, missing fields, an http homepage and a wrong repository", () => {
    const root = fixture("violations");
    const f = run(root);
    expect(f.every((x) => x.rule === "plugin-release-metadata")).toBe(true);
    expect(f.map((x) => [relative(root, x.file), x.message.split(":")[0]])).toEqual([
      ["plugins/example-demo/package.json", "plugins/example-demo must not be published"],
      ["plugins/no-desc/package.json", 'plugins/no-desc is published and needs a "description"'],
      ["plugins/no-desc/package.json", 'plugins/no-desc is published and needs a "license"'],
      ["plugins/wrong-dir/package.json", 'plugins/wrong-dir is published and needs "repository"'],
      [
        "plugins/wrong-url/package.json",
        'plugins/wrong-url is published and needs an https "homepage"',
      ],
      ["plugins/wrong-url/package.json", 'plugins/wrong-url is published and needs "repository"'],
    ]);
  });

  it("takes the repository URL from the root package.json, so each repository checks its own", () => {
    const root = fixture("violations");
    const wrong = run(root).filter((x) => x.file.includes("wrong-"));
    for (const x of wrong.filter((w) => w.message.includes("repository"))) {
      expect(x.message).toContain('"url": "git+https://github.com/capybara-hq/core.git"');
    }
    expect(wrong.find((x) => x.file.includes("wrong-dir"))?.message).toContain(
      '"directory": "plugins/wrong-dir"',
    );
  });

  it("a root package.json without repository.url is reported once", () => {
    const root = fixture("no-root-url");
    expect(run(root)).toEqual([
      {
        file: join(root, "package.json"),
        line: 1,
        rule: "plugin-release-metadata",
        message: expect.stringContaining('needs "repository": { "type": "git", "url": … }'),
      },
    ]);
  });

  it("the plugins of this repository pass", () => {
    expect(run(repo)).toEqual([]);
  });
});
