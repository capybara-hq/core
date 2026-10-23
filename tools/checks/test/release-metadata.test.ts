import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReleaseMetadata } from "../src/release-metadata.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/release-metadata/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("checkReleaseMetadata", () => {
  it("passes when published packages carry repository metadata and the rest are private", () => {
    expect(checkReleaseMetadata(fixture("clean"))).toEqual([]);
  });

  it("reports missing / wrong repository, description, homepage, files and public must-be-private packages", () => {
    const root = fixture("violations");
    const f = checkReleaseMetadata(root).map((x) => [
      relative(root, x.file).split("\\").join("/"),
      x.rule,
    ]);
    expect(f).toEqual([
      ["apps/web/package.json", "release-image-version"],
      [".changeset/config.json", "release-image-version"],
      ["packages/design/package.json", "release-private"],
      ["packages/no-files-homepage/package.json", "release-homepage"],
      ["packages/no-files-homepage/package.json", "release-files"],
      ["packages/no-repo/package.json", "release-repository"],
      ["plugins/example-demo/package.json", "release-private"],
      ["plugins/no-desc/package.json", "release-description"],
      ["plugins/no-desc/package.json", "release-license"],
      ["plugins/wrong-dir/package.json", "release-repository"],
    ]);
  });

  it("names the expected repository directory in the message", () => {
    const f = checkReleaseMetadata(fixture("violations")).find(
      (x) => x.file === join(fixture("violations"), "plugins/wrong-dir/package.json"),
    );
    expect(f?.message).toContain('"directory": "plugins/wrong-dir"');
  });

  it("names both versions when the image tag source and the web app differ", () => {
    const f = checkReleaseMetadata(fixture("violations")).find(
      (x) => x.file === join(fixture("violations"), "apps/web/package.json"),
    );
    expect(f?.message).toContain("0.1.0");
    expect(f?.message).toContain("0.2.0");
  });

  it("passes on the repository", () => {
    expect(checkReleaseMetadata(repoRoot)).toEqual([]);
  });
});
