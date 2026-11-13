import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheEnv, prepareSocketDir, socketDirPath } from "../src/exec/shared.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "device-dirs-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("prepareSocketDir", () => {
  const path = () => socketDirPath("0123456789abcdef", base);

  it("makes a missing directory with mode 0700", () => {
    expect(path()).toBe(join(base, "cap-01234567"));
    expect(prepareSocketDir(path())).toBe(path());
    expect(statSync(path()).mode & 0o777).toBe(0o700);
  });

  it("takes back an own directory with the wrong mode", () => {
    mkdirSync(path());
    chmodSync(path(), 0o777);
    expect(prepareSocketDir(path())).toBe(path());
    expect(statSync(path()).mode & 0o777).toBe(0o700);
  });

  it("refuses a link, never following it or changing its target", () => {
    const target = join(base, "target");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, path());
    expect(prepareSocketDir(path())).toBeUndefined();
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(lstatSync(path()).isSymbolicLink()).toBe(true);
  });

  it("refuses a file and another user's directory", () => {
    writeFileSync(path(), "x");
    expect(prepareSocketDir(path())).toBeUndefined();
    rmSync(path());
    mkdirSync(path(), { mode: 0o755 });
    const other = (process.getuid?.() ?? 0) + 1;
    expect(prepareSocketDir(path(), other)).toBeUndefined();
    expect(statSync(path()).mode & 0o777).toBe(0o755);
  });
});

describe("cacheEnv", () => {
  it("points every variable at a folder of the cache root, made on demand", () => {
    const root = join(base, "cache");
    const env = cacheEnv(root, { create: true });
    expect(Object.keys(env)).toHaveLength(11);
    expect(env.npm_config_cache).toBe(join(root, "npm"));
    expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${join(root, "maven")}`);
    expect(statSync(join(root, "npm")).isDirectory()).toBe(true);
    expect(existsSync(join(base, "other"))).toBe(false);
    // without create nothing is made
    expect(cacheEnv(join(base, "none")).npm_config_cache).toBe(join(base, "none", "npm"));
    expect(existsSync(join(base, "none"))).toBe(false);
  });

  it("sets only npm_config_ variables npm knows (an unknown one makes every npm command warn)", () => {
    const env = cacheEnv(join(base, "cache"));
    const npmKeys = Object.keys(env).filter((k) => k.toLowerCase().startsWith("npm_config_"));
    // pnpm 10 reads its store-dir only from npm_config_store_dir (no pnpm-only variable), which
    // npm reports as 'Unknown env config "store-dir"': the store is left at pnpm's default.
    expect(npmKeys).toEqual(["npm_config_cache"]);
    expect(env).not.toHaveProperty("npm_config_store_dir");
  });

  it("leaves out a folder a command replaced with a file or a link, never touching it", () => {
    const root = join(base, "cache");
    mkdirSync(root);
    writeFileSync(join(root, "npm"), "x");
    const victim = join(base, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep"), "x");
    symlinkSync(victim, join(root, "pip"));
    const env = cacheEnv(root, { create: true });
    expect(env.npm_config_cache).toBeUndefined();
    expect(env.PIP_CACHE_DIR).toBeUndefined();
    expect(env.UV_CACHE_DIR).toBe(join(root, "uv"));
    // neither replaced nor followed
    expect(lstatSync(join(root, "npm")).isFile()).toBe(true);
    expect(lstatSync(join(root, "pip")).isSymbolicLink()).toBe(true);
    expect(readdirSync(victim)).toEqual(["keep"]);
  });

  it("removes a link in the cache root's place without following it", () => {
    // a sandboxed command may write <dir>/cache: rm -rf it and link it to a host folder
    const victim = join(base, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "npm"), "x");
    const root = join(base, "cache");
    symlinkSync(victim, root);
    const env = cacheEnv(root, { create: true });
    expect(env.npm_config_cache).toBe(join(root, "npm"));
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    // the link's target is untouched: its file stays, no folder was made there
    expect(readdirSync(victim)).toEqual(["npm"]);
    expect(lstatSync(join(victim, "npm")).isFile()).toBe(true);
  });

  it("replaces a file in the cache root's place", () => {
    const root = join(base, "cache");
    writeFileSync(root, "x");
    expect(Object.keys(cacheEnv(root, { create: true }))).toHaveLength(11);
    expect(lstatSync(root).isDirectory()).toBe(true);
  });

  it("leaves every variable out when the cache root cannot be made, never throwing", () => {
    // the cache root's parent is a file: nothing can be made
    const parent = join(base, "file");
    writeFileSync(parent, "x");
    expect(cacheEnv(join(parent, "cache"), { create: true })).toEqual({});
  });
});
