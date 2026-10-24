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
  it("auto: npmReleased comes from the registry; nothing on npm -> no ghcr lookups", async () => {
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
    });
    expect(p).toMatchObject({ push: false, build: [] });
    expect(p.reason).toMatch(/nothing is on npm/);
    expect(looked).toBe(0);
  });

  it("auto: released on npm -> builds the missing images", async () => {
    const p = await planImageRelease({
      mode: "auto",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.0"],
      tagState: missing,
      listTags: async () => ["0.1.0", "latest"],
    });
    expect(p).toMatchObject({ version: "0.1.1", push: true });
    expect(p.build.map((t) => t.latest)).toEqual([true, true, true, true]);
  });

  it("re-running an old failed run rebuilds that run's own version, without latest", async () => {
    // The old commit's tree says 0.1.1; main has moved on and 0.1.2 is already released.
    const asked: string[] = [];
    const p = await planImageRelease({
      mode: "auto",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.1", "0.1.2"],
      tagState: async (image, tag) => {
        asked.push(tag);
        return image === "capybara-web" ? "missing" : "present";
      },
      listTags: async () => ["0.1.0", "0.1.2", "latest"],
    });
    expect(p.version).toBe("0.1.1");
    expect(p.build).toEqual([expect.objectContaining({ image: "capybara-web", latest: false })]);
    expect(new Set(asked)).toEqual(new Set(["0.1.1"]));
  });

  it("never builds a version other than the apps/capybara version of its own tree", async () => {
    for (const mode of ["auto", "manual", "dry-run"] as const) {
      write("apps/capybara", { name: "@capybara-hq/capybara", version: "0.4.0", private: true });
      const asked = new Set<string>();
      const p = await planImageRelease({
        mode,
        root,
        log: quiet,
        publishedVersions: async () => ["0.3.0", "0.5.0"],
        tagState: async (_image, tag) => {
          asked.add(tag);
          return "missing";
        },
        listTags: async () => ["0.5.0", "9.9.9"],
      });
      expect(p.version, mode).toBe("0.4.0");
      expect(
        [...asked].every((t) => t === "0.4.0"),
        mode,
      ).toBe(true);
    }
  });

  it("manual: a higher existing tag keeps latest", async () => {
    const p = await planImageRelease({
      mode: "manual",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.1"],
      tagState: async (image) => (image === "capybara-web" ? "missing" : "present"),
      listTags: async () => ["0.1.1", "0.2.0"],
    });
    expect(p.build.map((t) => [t.image, t.latest])).toEqual([["capybara-web", false]]);
  });

  it("manual: the first release keeps latest although npm already shows it", async () => {
    // The real order: the `publish` job of the same run has already put 0.1.1 on npm, and none of
    // the four image packages exists yet, so every lookup is denied and there are no tags at all.
    const p = await planImageRelease({
      mode: "manual",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.1"],
      tagState: async () => "denied",
      listTags: async () => [],
    });
    expect(p.build).toHaveLength(4);
    expect(p.build.every((t) => t.latest)).toBe(true);
  });

  it("manual: re-running an old run while ghcr access is denied never tags latest", async () => {
    // Private packages or a token problem: every lookup is denied and listTags reads []. npm shows
    // a newer version than this tree's 0.1.1, so this is not the first release.
    const p = await planImageRelease({
      mode: "manual",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.1", "0.1.2"],
      tagState: async () => "denied",
      listTags: async () => [],
    });
    expect(p.build).toHaveLength(4);
    expect(p.build.some((t) => t.latest)).toBe(false);
  });

  it("manual: once some image package exists, a denied lookup drops latest", async () => {
    const p = await planImageRelease({
      mode: "manual",
      root,
      log: quiet,
      publishedVersions: async () => ["0.1.0", "0.1.1"],
      tagState: async (image) => (image === "capybara-web" ? "denied" : "missing"),
      listTags: async (image) => (image === "capybara-web" ? [] : ["0.1.0", "latest"]),
    });
    expect(Object.fromEntries(p.build.map((t) => [t.image, t.latest]))).toEqual({
      "capybara-api": true,
      "capybara-worker": true,
      "capybara-gateway": true,
      "capybara-web": false,
    });
  });

  it("dry-run: no lookups at all", async () => {
    const p = await planImageRelease({
      mode: "dry-run",
      root,
      tagState: present,
      publishedVersions: async () => {
        throw new Error("npm must not be asked");
      },
    });
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
      publishedVersions: async () => ["0.1.0"],
      tagState: async (image) => (image === "capybara-api" ? "missing" : "present"),
      listTags: async () => [],
    });
    expect(imageOutputs(p)).toBe(
      [
        "version=0.1.1",
        "push=true",
        "latest=true",
        "build=true",
        'matrix=[{"image":"capybara-api","dockerfile":"docker/kernel.Dockerfile","roles":"api","cache":"kernel","latest":true}]',
        "",
      ].join("\n"),
    );
  });
});
