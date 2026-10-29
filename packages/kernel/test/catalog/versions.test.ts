import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import semver from "semver";
import { describe, expect, it } from "vitest";
import { recordedVersion } from "../../src/catalog/catalog-items.js";
import {
  archiveFallbackVersion,
  contentDigest,
  readPluginFiles,
  readPluginPackage,
} from "../../src/catalog/plugin-package.js";
import {
  compareVersions,
  maxSatisfying,
  newestFirst,
  sameRelease,
  satisfiesRange,
  withBuild,
} from "../../src/catalog/versions.js";
import { ApiError } from "../../src/errors.js";
import { packPackageTgz, unpackPackageTgz } from "../../src/packages/tgz.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { SKILL_MD } from "../skills/zip.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("version order (spec §5.3)", () => {
  it("build metadata is ignored by ranges: 1.0.0+git.abc and 1.0.0 both satisfy ^1.0.0", () => {
    expect(satisfiesRange("1.0.0+git.abc", "^1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "^1.0.0")).toBe(true);
    expect(satisfiesRange("0.0.0-git.g0123", "*")).toBe(true);
    expect(satisfiesRange("2.0.0+git.abc", "^1.0.0")).toBe(false);
  });

  it("a release candidate satisfies a prerelease range (phase A3b releases 0.1.0-rc.0 first)", () => {
    // plugin.json dependency ranges between official plugins are ^0.1.0-rc.0 during the rcs
    expect(satisfiesRange("0.1.0-rc.0", "^0.1.0-rc.0")).toBe(true);
    expect(satisfiesRange("0.1.0-rc.1", "^0.1.0-rc.0")).toBe(true);
    expect(satisfiesRange("0.1.0", "^0.1.0-rc.0")).toBe(true);
    expect(satisfiesRange("0.1.3", "^0.1.0-rc.0")).toBe(true);
    expect(satisfiesRange("0.2.0-rc.0", "^0.1.0-rc.0")).toBe(false);
    // a plain ^0.1.0 never matches an rc of 0.1.0 (it sorts below 0.1.0)
    expect(satisfiesRange("0.1.0-rc.0", "^0.1.0")).toBe(false);
    expect(maxSatisfying(["0.1.0-rc.0", "0.1.0-rc.1", "0.0.9"], "^0.1.0-rc.0")).toBe("0.1.0-rc.1");
    expect(maxSatisfying(["0.1.0-rc.1", "0.1.0"], "^0.1.0-rc.0")).toBe("0.1.0");
  });

  it("versions equal but for build metadata are ordered by import time", () => {
    const early = { version: "1.0.0+git.bbb", importedAt: new Date("2026-01-01T00:00:00Z") };
    const late = { version: "1.0.0", importedAt: new Date("2026-02-01T00:00:00Z") };
    expect(compareVersions(early, late)).toBeLessThan(0);
    expect(compareVersions("1.0.0+git.abc", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.0+git.zzz")).toBeGreaterThan(0);
    const sorted = [late, { version: "0.9.0", importedAt: new Date() }, early].sort(newestFirst);
    expect(sorted.map((v) => v.version)).toEqual(["1.0.0", "1.0.0+git.bbb", "0.9.0"]);
    // the latest-version pick ignores build metadata and takes the later import on a tie
    expect(maxSatisfying([late, early], "^1.0.0")).toBe(late);
    expect(
      maxSatisfying([{ ...early, importedAt: new Date("2026-03-01T00:00:00Z") }, late], "^1.0.0")
        ?.version,
    ).toBe("1.0.0+git.bbb");
    expect(maxSatisfying(["1.0.0", "1.2.0+sha256.x", "2.0.0"], "^1.0.0")).toBe("1.2.0+sha256.x");
    expect(maxSatisfying(["2.0.0"], "^1.0.0")).toBeUndefined();
  });

  it("build suffixes and fallback versions are valid semver, leading zeros included", () => {
    const digits = `012345678901${"0".repeat(52)}`;
    // semver.valid normalizes build metadata away; parse keeps it
    const git = withBuild("1.0.0", `git.${digits.slice(0, 12)}`);
    expect(git).toBe("1.0.0+git.012345678901");
    expect(semver.valid(git)).toBe("1.0.0");
    expect(semver.parse(git)?.build).toEqual(["git", "012345678901"]);
    const sha = withBuild("1.0.0", `sha256.${digits.slice(0, 12)}`);
    expect(semver.parse(sha)?.build).toEqual(["sha256", "012345678901"]);
    expect(withBuild("1.0.0+b1", "git.abc")).toBe("1.0.0+b1.git.abc");
    expect(semver.valid(withBuild("1.0.0+b1", "git.abc"))).not.toBeNull();
    expect(archiveFallbackVersion(digits)).toBe("0.0.0-sha256.h012345678901");
    expect(semver.valid(archiveFallbackVersion(digits))).toBe("0.0.0-sha256.h012345678901");
  });
});

describe("sameRelease", () => {
  it("is false (never throws) when either side is not semver", () => {
    expect(sameRelease("1.0.0+git.a", "1.0.0")).toBe(true);
    expect(sameRelease("1.0.0", "1.0.1")).toBe(false);
    expect(sameRelease("not-a-version", "1.0.0")).toBe(false);
    expect(sameRelease("1.0.0", "")).toBe(false);
  });
});

describe("content digest (Decision 5)", () => {
  it("refuses a path with a control character (the line format would be ambiguous)", () => {
    expect(() => contentDigest(new Map([["a\nb", enc("x")]]))).toThrow(/unsafe path/);
    expect(() => contentDigest(new Map([["a\u0000b", enc("x")]]))).toThrow(/unsafe path/);
  });

  it("is sha256 over the sorted `path\\0sha256(content)\\n` list", async () => {
    const { createHash } = await import("node:crypto");
    const h = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
    const files = new Map([
      ["b.txt", enc("B")],
      ["a.txt", enc("A")],
    ]);
    expect(contentDigest(files)).toBe(h(`a.txt\0${h(enc("A"))}\nb.txt\0${h(enc("B"))}\n`));
  });

  it("is the same for a tgz and a git tree of the same files, whatever the tgz bytes", async () => {
    const tgz = await pluginTgz({
      manifest: { name: "dig" },
      files: { "skills/dig/SKILL.md": SKILL_MD("dig") },
    });
    const files = new Map<string, Uint8Array>(
      (await unpackPackageTgz(tgz, { maxBytes: 1 << 20 })).map((f) => [f.path, f.data] as const),
    );
    const fromTgz = await readPluginPackage(tgz, {
      maxBytes: 1 << 20,
      hostSdkVersion: SDK_VERSION,
    });
    const repacked = await readPluginPackage(await packPackageTgz(files), {
      maxBytes: 1 << 20,
      hostSdkVersion: SDK_VERSION,
    });
    const fromGit = readPluginFiles(files, {
      hostSdkVersion: SDK_VERSION,
      requirePackageJson: false,
    });
    expect(fromTgz.sha256).not.toBe(repacked.sha256);
    expect(fromTgz.contentDigest).toBe(contentDigest(files));
    expect(repacked.contentDigest).toBe(fromTgz.contentDigest);
    expect(fromGit.contentDigest).toBe(fromTgz.contentDigest);
    files.set("skills/dig/NOTES.md", enc("more\n"));
    expect(contentDigest(files)).not.toBe(fromTgz.contentDigest);
  });

  it("an archive without plugin.json is skills only, versioned 0.0.0-sha256.h<12> unless the entry says", async () => {
    const files = new Map([["skills/lone/SKILL.md", enc(SKILL_MD("lone"))]]);
    const tgz = await packPackageTgz(files);
    const opts = { maxBytes: 1 << 20, hostSdkVersion: SDK_VERSION };
    const a = await readPluginPackage(tgz, {
      ...opts,
      fallback: { name: "lone", publisher: "Acme" },
    });
    expect(a.manifest).toMatchObject({ name: "lone", publisher: "Acme" });
    expect(a.manifest.version).toBe(archiveFallbackVersion(contentDigest(files)));
    const b = await readPluginPackage(tgz, {
      ...opts,
      fallback: { name: "lone", version: "2.0.0", publisher: "Acme" },
    });
    expect(b.manifest.version).toBe("2.0.0");
    // without a fallback (an upload, npm) plugin.json stays required
    await expect(readPluginPackage(tgz, opts)).rejects.toThrow(/plugin\.json not found/);
  });
});

describe("recorded version (Decision 6)", () => {
  const D1 = "a".repeat(64);
  const D2 = "b".repeat(64);
  const git = (commit: string) => ({
    host: "git.example.com",
    repo: "acme/x.git",
    path: ".",
    commit,
    followsBranch: true,
  });
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof ApiError ? [e.code, e.message] : e;
    }
    return undefined;
  };

  it("a new release keeps its version", () => {
    expect(
      recordedVersion([{ version: "1.0.0", content_digest: D1, integrity: null }], {
        packageName: null,
        version: "1.1.0",
        contentDigest: D2,
      }),
    ).toBe("1.1.0");
  });

  it("other content at an imported version gets +git.<sha12> or +sha256.<12>", () => {
    const existing = [{ version: "1.0.0", content_digest: D1, integrity: null }];
    const commit = `0${"c".repeat(39)}`;
    expect(
      recordedVersion(existing, {
        packageName: null,
        version: "1.0.0",
        contentDigest: D2,
        detail: git(commit),
      }),
    ).toBe(`1.0.0+git.${commit.slice(0, 12)}`);
    expect(
      recordedVersion(existing, { packageName: "@a/b", version: "1.0.0", contentDigest: D2 }),
    ).toBe(`1.0.0+sha256.${D2.slice(0, 12)}`);
  });

  it("the same content under any version of the release is already imported", () => {
    const existing = [
      { version: "1.0.0", content_digest: D1, integrity: null },
      { version: `1.0.0+sha256.${D2.slice(0, 12)}`, content_digest: D2, integrity: null },
    ];
    expect(
      code(() =>
        recordedVersion(existing, { packageName: null, version: "1.0.0", contentDigest: D2 }),
      ),
    ).toEqual([
      "catalog.version_exists",
      `Version 1.0.0+sha256.${D2.slice(0, 12)} of this catalog item is already imported with the same content`,
    ]);
    expect(
      code(() =>
        recordedVersion(existing, { packageName: null, version: "1.0.0", contentDigest: D1 }),
      ),
    ).toEqual([
      "catalog.version_exists",
      "Version 1.0.0 of this catalog item is already imported with the same content",
    ]);
  });

  it("a version imported before digests is compared by integrity when both have one", () => {
    const existing = [{ version: "1.0.0", content_digest: null, integrity: "sha512-x" }];
    expect(
      (
        code(() =>
          recordedVersion(existing, {
            packageName: "@a/b",
            version: "1.0.0",
            contentDigest: D1,
            integrity: "sha512-x",
          }),
        ) as string[]
      )[0],
    ).toBe("catalog.version_exists");
    expect(
      recordedVersion(existing, {
        packageName: "@a/b",
        version: "1.0.0",
        contentDigest: D1,
        integrity: "sha512-y",
      }),
    ).toBe(`1.0.0+sha256.${D1.slice(0, 12)}`);
  });
});
