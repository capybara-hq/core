import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TagState } from "../src/images.js";
import { imageOutputs, planImageRelease } from "../src/images-release.js";

let root: string;
const write = (dir: string, pkg: Record<string, unknown>) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "images-release-"));
  write("apps/capybara", { name: "@capybara-hq/capybara", version: "0.1.1", private: true });
  write("packages/kernel", { name: "@capybara-hq/kernel", version: "0.1.1" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const present = async (): Promise<TagState> => "present";
const missing = async (): Promise<TagState> => "missing";
const quiet = () => {};

describe("planImageRelease", () => {
  it("auto: npmReleased comes from the registry; nothing on npm -> no registry or head lookups", async () => {
    let looked = 0;
    const p = await planImageRelease({
      mode: "auto",
      root,
      log: quiet,
      publishedVersions: async () => [],
      tagState: async () => {
        looked++;
        return "missing";
      },
      mainHead: async () => {
        looked++;
        return "abc";
      },
      sha: "abc",
    });
    expect(p).toMatchObject({ push: false, build: [] });
    expect(p.reason).toMatch(/nothing is on npm/);
    expect(looked).toBe(0);
  });

  it("auto: released on npm and head of main -> builds the missing images", async () => {
    const p = await planImageRelease({
      mode: "auto",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.0"],
      tagState: missing,
      listTags: async () => ["0.1.0", "latest"],
      mainHead: async () => "abc",
      sha: "abc",
    });
    expect(p).toMatchObject({ version: "0.1.1", push: true, latest: true });
    expect(p.build).toHaveLength(4);
  });

  it("auto: an older commit than the head of main builds nothing", async () => {
    const p = await planImageRelease({
      mode: "auto",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.0"],
      tagState: missing,
      listTags: async () => [],
      mainHead: async () => "newer",
      sha: "abc",
    });
    expect(p).toMatchObject({ push: false, build: [] });
  });

  it("auto: refuses to guess without GITHUB_SHA", async () => {
    await expect(
      planImageRelease({
        mode: "auto",
        root,
        log: quiet,
        publishedVersions: async () => ["0.1.0"],
        mainHead: async () => "abc",
      }),
    ).rejects.toThrow(/GITHUB_SHA/);
  });

  it("manual: no npm or head lookups; latest stays on a higher existing tag", async () => {
    const p = await planImageRelease({
      mode: "manual",
      root,
      log: quiet,
      publishedVersions: async () => {
        throw new Error("npm must not be asked");
      },
      tagState: async (image) => (image === "capybara-web" ? "missing" : "present"),
      listTags: async () => ["0.1.1", "0.2.0"],
    });
    expect(p.build.map((t) => t.image)).toEqual(["capybara-web"]);
    expect(p.latest).toBe(false);
  });

  it("dry-run: no lookups at all", async () => {
    const p = await planImageRelease({ mode: "dry-run", root, tagState: present });
    expect(p).toMatchObject({ push: false });
    expect(p.build).toHaveLength(4);
  });
});

describe("imageOutputs", () => {
  it("one key=value line per output, the matrix as single-line JSON", async () => {
    const p = await planImageRelease({
      mode: "manual",
      root,
      log: quiet,
      tagState: async (image) => (image === "capybara-api" ? "missing" : "present"),
      listTags: async () => [],
    });
    expect(imageOutputs(p)).toBe(
      [
        "version=0.1.1",
        "push=true",
        "latest=true",
        "build=true",
        'matrix=[{"image":"capybara-api","dockerfile":"docker/kernel.Dockerfile","roles":"api","cache":"kernel"}]',
        "",
      ].join("\n"),
    );
  });
});
