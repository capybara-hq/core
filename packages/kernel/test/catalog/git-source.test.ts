import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { type FakeGitServer, startFakeGitServer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  expandGitUrl,
  GIT_LIMITS,
  type GitOptions,
  GitSourceError,
  readGitTree,
  resolveGitCommit,
  scanPack,
} from "../../src/catalog/git-source.js";
import {
  PluginPackageError,
  readPluginFiles,
  readPluginPackage,
} from "../../src/catalog/plugin-package.js";
import type { NetPolicy } from "../../src/net/public-address.js";
import { pluginTgz, tgz } from "../helpers/plugin-packages.js";
import { SKILL_MD } from "../skills/zip.js";

const NET: NetPolicy = { allowInsecureLoopback: true, allowPrivateHosts: [], trustedOrigins: [] };
const SDK = "0.1.0";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);

let srv: FakeGitServer;
/** The temp object stores of this file go here, so the cleanup check sees only them. */
let tempRoot: string;
const opts = (over: Partial<GitOptions> = {}): GitOptions => ({
  net: NET,
  signal: AbortSignal.timeout(60_000),
  maxBytes: 10 * 1024 * 1024,
  tempRoot,
  ...over,
});

/** The code of a rejected git call. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitSourceError) return e.code;
    throw e;
  }
  throw new Error("expected a GitSourceError");
}

beforeAll(async () => {
  srv = await startFakeGitServer();
  tempRoot = await mkdtemp(join(tmpdir(), "git-source-test-"));
});
afterEach(async () => {
  // the temp object store is removed after every operation, read or refused
  expect(await readdir(tempRoot)).toEqual([]);
});
afterAll(async () => {
  await srv?.stop();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("expandGitUrl", () => {
  it("expands owner/repo to a GitHub URL and leaves URLs alone", () => {
    expect(expandGitUrl("acme/tools")).toBe("https://github.com/acme/tools.git");
    expect(expandGitUrl("acme/tools.git")).toBe("https://github.com/acme/tools.git");
    expect(expandGitUrl("https://gitlab.example.com/a/b.git")).toBe(
      "https://gitlab.example.com/a/b.git",
    );
    expect(expandGitUrl("acme/../x")).toBe("acme/../x");
  });
});

describe("resolveGitCommit", () => {
  it("resolves the remote HEAD, a branch, a full ref and a given commit", async () => {
    const main = await srv.commit("resolve", { "a.txt": "main" });
    const dev = await srv.commit("resolve", { "a.txt": "dev" }, { branch: "dev" });
    const url = srv.url("resolve");
    expect(await resolveGitCommit({ url }, opts())).toBe(main);
    expect(await resolveGitCommit({ url, ref: "dev" }, opts())).toBe(dev);
    expect(await resolveGitCommit({ url, ref: "refs/heads/dev" }, opts())).toBe(dev);
    // with both, the commit wins (spec §5.2)
    expect(await resolveGitCommit({ url, ref: "dev", commit: main.toUpperCase() }, opts())).toBe(
      main,
    );
    expect(await codeOf(resolveGitCommit({ url, ref: "nope" }, opts()))).toBe(
      "marketplace.git_failed",
    );
    expect(await codeOf(resolveGitCommit({ url, commit: "abc" }, opts()))).toBe(
      "marketplace.git_failed",
    );
  });

  it("resolves lightweight and annotated tags to their commit", async () => {
    const light = await srv.commit("tags", { "a.txt": "1" }, { tag: { name: "v1" } });
    const annotated = await srv.commit(
      "tags",
      { "a.txt": "2" },
      { tag: { name: "v2", annotated: true } },
    );
    const url = srv.url("tags");
    expect(await resolveGitCommit({ url, ref: "v1" }, opts())).toBe(light);
    expect(await resolveGitCommit({ url, ref: "v2" }, opts())).toBe(annotated);
    expect(await resolveGitCommit({ url, ref: "refs/tags/v2" }, opts())).toBe(annotated);
  });

  it("takes a 40-hex ref as the commit without asking the server", async () => {
    srv.requests.length = 0;
    const sha = "ABCDEF0123456789abcdef0123456789ABCDEF01";
    expect(await resolveGitCommit({ url: srv.url("none"), ref: sha }, opts())).toBe(
      sha.toLowerCase(),
    );
    expect(srv.requests).toEqual([]);
  });

  it("fails on a missing repo and on a redirect", async () => {
    expect(await codeOf(resolveGitCommit({ url: srv.url("missing") }, opts()))).toBe(
      "marketplace.git_failed",
    );
    await srv.commit("redirect", { "a.txt": "x" });
    srv.setRedirect("http://10.0.0.1/x.git");
    try {
      const e = await resolveGitCommit({ url: srv.url("redirect") }, opts()).catch((x) => x);
      expect(e).toBeInstanceOf(GitSourceError);
      expect(e.code).toBe("marketplace.git_failed");
      expect(e.netCode).toBe("marketplace.redirect");
    } finally {
      srv.setRedirect(null);
    }
  });

  it("refuses plain http outside loopback rules and URLs with credentials", async () => {
    const e = await resolveGitCommit(
      { url: srv.url("resolve") },
      opts({ net: { ...NET, allowInsecureLoopback: false } }),
    ).catch((x) => x);
    expect(e.code).toBe("marketplace.git_failed");
    const url = srv.url("resolve").replace("http://", "http://u:p@");
    expect(await codeOf(resolveGitCommit({ url }, opts()))).toBe("marketplace.git_failed");
  });
});

describe("readGitTree", () => {
  const files = {
    "README.md": "# repo\n",
    "plugins/a/.capybara-plugin/plugin.json": '{"name":"a"}\n',
    "plugins/a/skills/x/SKILL.md": SKILL_MD("x"),
    "plugins/a/bin/data.bin": "\u0000\u0001ÿ binary-ish",
    "plugins/b/skills/y/SKILL.md": SKILL_MD("y"),
  };

  it("reads the whole tree and a subdirectory byte for byte, deterministically", async () => {
    const commit = await srv.commit("tree", files);
    const url = srv.url("tree");
    const all = await readGitTree({ url, commit }, opts());
    expect([...all.keys()]).toEqual(Object.keys(files).sort());
    for (const [p, c] of Object.entries(files)) {
      expect(Buffer.from(all.get(p) as Uint8Array).equals(Buffer.from(c))).toBe(true);
    }
    const sub = await readGitTree({ url, commit, path: "./plugins/a/" }, opts());
    expect([...sub.keys()]).toEqual([
      ".capybara-plugin/plugin.json",
      "bin/data.bin",
      "skills/x/SKILL.md",
    ]);
    expect(dec(sub.get("skills/x/SKILL.md"))).toBe(SKILL_MD("x"));
    const again = await readGitTree({ url, commit, path: "plugins/a" }, opts());
    expect([...again.entries()]).toEqual([...sub.entries()]);
  });

  it("reads an older commit that is no longer a branch head", async () => {
    const old = await srv.commit("history", { "v.txt": "one" });
    await srv.commit("history", { "v.txt": "two" });
    const t = await readGitTree({ url: srv.url("history"), commit: old }, opts());
    expect(dec(t.get("v.txt"))).toBe("one");
  });

  it("refuses bad paths and a path that is missing", async () => {
    const commit = await srv.commit("paths", { "a/b.txt": "x" });
    const url = srv.url("paths");
    for (const path of ["../a", "a/../a", "/a", "a//b"]) {
      expect(await codeOf(readGitTree({ url, commit, path }, opts()))).toBe(
        "marketplace.git_failed",
      );
    }
    expect(await codeOf(readGitTree({ url, commit, path: "nope" }, opts()))).toBe(
      "marketplace.git_failed",
    );
    expect(await codeOf(readGitTree({ url, commit, path: "a/b.txt" }, opts()))).toBe(
      "marketplace.git_failed",
    );
  });

  it("refuses symlink and submodule entries", async () => {
    const url = srv.url("links");
    const link = await srv.commit(
      "links",
      { "p/a.txt": "x" },
      { symlinks: { "p/l": "../../etc" } },
    );
    expect(await codeOf(readGitTree({ url, commit: link, path: "p" }, opts()))).toBe(
      "marketplace.git_unsupported_entry",
    );
    const sub = await srv.commit(
      "links",
      { "p/a.txt": "x" },
      { submodules: { "p/sub": "1234567890123456789012345678901234567890" } },
    );
    expect(await codeOf(readGitTree({ url, commit: sub, path: "p" }, opts()))).toBe(
      "marketplace.git_unsupported_entry",
    );
    // a symlink on the way to `path`
    const via = await srv.commit("links", { "real/a.txt": "x" }, { symlinks: { p: "real" } });
    expect(await codeOf(readGitTree({ url, commit: via, path: "p" }, opts()))).toBe(
      "marketplace.git_unsupported_entry",
    );
  });

  it("refuses a tree over the file limit", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= GIT_LIMITS.maxFiles; i++) many[`f/${i}.txt`] = String(i);
    const commit = await srv.commit("many", many);
    expect(await codeOf(readGitTree({ url: srv.url("many"), commit }, opts()))).toBe(
      "marketplace.git_too_large",
    );
  }, 60_000);

  it("refuses a tree-only DAG with exponentially many paths", async () => {
    // 11 tree objects, 26^10 paths and no files: bounded by the entry count, not the file count
    const commit = await srv.commit(
      "dag",
      { "a.txt": "x" },
      { treeDag: { name: "dag", fanout: 26, depth: 10 } },
    );
    const e = await readGitTree({ url: srv.url("dag"), commit }, opts()).catch((x) => x);
    expect(e).toBeInstanceOf(GitSourceError);
    expect(e.code).toBe("marketplace.git_too_large");
    expect(e.message).toContain(`more than ${GIT_LIMITS.maxObjects} entries`);
  });

  it("refuses a pack over maxBytes and content over the unpacked limit", async () => {
    // random-ish text compresses poorly: the pack is bigger than 4 KiB
    let noise = "";
    for (let i = 0; i < 2000; i++) noise += Math.random().toString(36).slice(2);
    const big = await srv.commit("big", { "n.txt": noise });
    expect(
      await codeOf(readGitTree({ url: srv.url("big"), commit: big }, opts({ maxBytes: 4096 }))),
    ).toBe("marketplace.git_too_large");
    // zeros compress well: a small pack whose content is over 4 x maxBytes
    const bomb = await srv.commit("bomb", { "z.txt": "0".repeat(200_000) });
    expect(
      await codeOf(readGitTree({ url: srv.url("bomb"), commit: bomb }, opts({ maxBytes: 20_000 }))),
    ).toBe("marketplace.git_too_large");
    const e = await readGitTree(
      { url: srv.url("bomb"), commit: bomb },
      opts({ maxBytes: 20_000 }),
    ).catch((x) => x);
    // refused by the pack scan, before isomorphic-git inflates the objects
    expect(e.message).toContain("the git content is larger than 80000 bytes unpacked");
  });

  it("sends the token only to tokenOrigin", async () => {
    const commit = await srv.commit("auth", { "a.txt": "x" });
    const url = srv.url("auth");
    const origin = new URL(url).origin;
    srv.requests.length = 0;
    await readGitTree({ url, commit }, opts({ token: "s3cret", tokenOrigin: origin }));
    expect(srv.requests.length).toBeGreaterThan(0);
    const basic = `Basic ${Buffer.from("x-access-token:s3cret").toString("base64")}`;
    expect(srv.requests.every((r) => r.authorization === basic)).toBe(true);
    srv.requests.length = 0;
    await resolveGitCommit(
      { url },
      opts({ token: "s3cret", tokenOrigin: "https://elsewhere.example.com" }),
    );
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((r) => r.authorization === undefined)).toBe(true);
  });
});

describe("scanPack", () => {
  /** A one-object pack: a blob declaring `declared` bytes, holding `content` deflated. */
  const pack = (declared: number, content: Buffer) => {
    const head = Buffer.alloc(12);
    head.write("PACK", 0, "latin1");
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(1, 8);
    const sizeBytes: number[] = [];
    let first = (3 << 4) | (declared & 15);
    let rest = Math.floor(declared / 16);
    if (rest > 0) first |= 0x80;
    sizeBytes.push(first);
    while (rest > 0) {
      const b = rest & 0x7f;
      rest = Math.floor(rest / 128);
      sizeBytes.push(rest > 0 ? b | 0x80 : b);
    }
    return Buffer.concat([head, Buffer.from(sizeBytes), deflateSync(content), Buffer.alloc(20)]);
  };

  it("accepts an honest pack and refuses one whose object inflates past its declared size", () => {
    const data = Buffer.alloc(5000, 0x61);
    expect(() => scanPack(pack(5000, data), 10_000)).not.toThrow();
    expect(() => scanPack(pack(5000, data), 4000)).toThrow(/unpacked/);
    const lying = (() => {
      try {
        scanPack(pack(10, data), 10_000);
      } catch (e) {
        return e as GitSourceError;
      }
    })();
    expect(lying?.code).toBe("marketplace.git_failed");
    expect(() => scanPack(Buffer.from("not a pack at all, really not a pack"), 10)).toThrow(
      /not a git pack/,
    );
  });
});

describe("readPluginFiles", () => {
  const skillsOnly = new Map([["skills/x/SKILL.md", enc(SKILL_MD("x"))]]);

  it("reads a skills-only tree without plugin.json or package.json using the fallbacks", () => {
    const p = readPluginFiles(skillsOnly, {
      hostSdkVersion: SDK,
      requirePackageJson: false,
      fallbackName: "my-skills",
      fallbackVersion: "0.0.0-git.0123456789ab",
    });
    expect(p.manifest.name).toBe("my-skills");
    expect(p.manifest.version).toBe("0.0.0-git.0123456789ab");
    expect(p.packageJson).toEqual({});
    expect(p.skills.map((s) => s.name)).toEqual(["x"]);
  });

  it("reads a plugin.json tree without package.json when package.json is not required", () => {
    const files = new Map(skillsOnly);
    files.set(
      ".capybara-plugin/plugin.json",
      enc(
        JSON.stringify({
          schemaVersion: 1,
          name: "named",
          version: "1.2.3",
          publisher: "acme",
          description: "d",
        }),
      ),
    );
    const p = readPluginFiles(files, { hostSdkVersion: SDK, requirePackageJson: false });
    expect(p.manifest.name).toBe("named");
  });

  it("still requires package.json and plugin.json on the tgz path", () => {
    const e = (() => {
      try {
        readPluginFiles(skillsOnly, {
          hostSdkVersion: SDK,
          requirePackageJson: true,
          fallbackName: "my-skills",
          fallbackVersion: "1.0.0",
        });
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(PluginPackageError);
    expect((e as PluginPackageError).issues.join("\n")).toContain("plugin.json not found");
    // without fallbacks, a git tree without plugin.json is refused too
    expect(() =>
      readPluginFiles(skillsOnly, { hostSdkVersion: SDK, requirePackageJson: false }),
    ).toThrow(PluginPackageError);
  });

  it("the tgz reader still refuses a package without package.json", async () => {
    const bytes = await tgz([
      {
        name: "package/.capybara-plugin/plugin.json",
        data: JSON.stringify({
          schemaVersion: 1,
          name: "x",
          version: "1.0.0",
          publisher: "p",
          description: "d",
        }),
      },
      { name: "package/skills/x/SKILL.md", data: SKILL_MD("x") },
    ]);
    const e = await readPluginPackage(bytes, { maxBytes: 1 << 20, hostSdkVersion: SDK }).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(PluginPackageError);
    expect(e.issues.join("\n")).toContain("package.json not found");
    // and a valid tgz still reads (sha256 and size added)
    const ok = await readPluginPackage(
      await pluginTgz({ manifest: { name: "ok" }, files: { "skills/x/SKILL.md": SKILL_MD("x") } }),
      { maxBytes: 1 << 20, hostSdkVersion: SDK },
    );
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.manifest.name).toBe("ok");
  });
});
