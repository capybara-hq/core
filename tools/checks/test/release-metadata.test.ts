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

  it("reports missing / wrong repository, missing description and public must-be-private packages", () => {
    const root = fixture("violations");
    const f = checkReleaseMetadata(root).map((x) => [
      relative(root, x.file).split("\\").join("/"),
      x.rule,
    ]);
    expect(f).toEqual([
      ["packages/design/package.json", "release-private"],
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

  it("passes on the repository", () => {
    expect(checkReleaseMetadata(repoRoot)).toEqual([]);
  });
});
