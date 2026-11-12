import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
    expect(Object.keys(env)).toHaveLength(12);
    expect(env.npm_config_cache).toBe(join(root, "npm"));
    expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${join(root, "maven")}`);
    expect(statSync(join(root, "pnpm-store")).isDirectory()).toBe(true);
    expect(existsSync(join(base, "other"))).toBe(false);
    // without create nothing is made
    expect(cacheEnv(join(base, "none")).npm_config_cache).toBe(join(base, "none", "npm"));
    expect(existsSync(join(base, "none"))).toBe(false);
  });

  it("replaces a file or a link in a folder's place, never following the link", () => {
    const root = join(base, "cache");
    mkdirSync(root);
    writeFileSync(join(root, "npm"), "x");
    const outside = join(base, "outside");
    symlinkSync(outside, join(root, "pip"));
    const env = cacheEnv(root, { create: true });
    expect(env.npm_config_cache).toBe(join(root, "npm"));
    expect(lstatSync(join(root, "npm")).isDirectory()).toBe(true);
    expect(lstatSync(join(root, "pip")).isDirectory()).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  it("leaves out a variable whose folder cannot be made, never throwing", () => {
    // the cache root itself is a file: no folder can be made under it
    const root = join(base, "cache");
    writeFileSync(root, "x");
    expect(cacheEnv(root, { create: true })).toEqual({});
  });
});
