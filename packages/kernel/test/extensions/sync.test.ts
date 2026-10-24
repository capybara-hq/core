import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionManifest } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearBrokenRoot, syncPackage } from "../../src/extensions/sync.js";
import { pluginTgz } from "../helpers/plugin-packages.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let dir: string;
let bytes: Uint8Array;
let digest: string;
let gets = 0;
const blobs = {
  get: async (s: string) => {
    gets++;
    if (s !== digest) throw new Error("unknown package");
    return bytes;
  },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "plugin-sync-"));
  bytes = await pluginTgz({ name: "sync-demo" });
  digest = sha(bytes);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("syncPackage", () => {
  it("解到 <dir>/<name>/<sha 前 16 位>/，返回 entry 的 file URL，宿主包链接到宿主副本", async () => {
    const url = await syncPackage(dir, "sync-demo", digest, blobs);
    const root = join(dir, "sync-demo", digest.slice(0, 16));
    expect(fileURLToPath(url)).toBe(join(root, "dist/index.mjs"));
    const sdk = join(root, "node_modules/@capybara-hq/plugin-sdk");
    expect((await lstat(sdk)).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, "node_modules/zod"))).isSymbolicLink()).toBe(true);
    expect(await readlink(sdk)).not.toBe("");
    // 只剩最终目录，没有遗留的临时目录
    expect(await readdir(join(dir, "sync-demo"))).toEqual([digest.slice(0, 16)]);
    // 插件能按宿主的 SDK 导入
    const mod = (await import(url)) as { default: ExtensionManifest };
    expect(mod.default.name).toBe("sync-demo");
  });

  it("同一 sha 再次同步时复用本地目录（不再取包）", async () => {
    const before = gets;
    const url = await syncPackage(dir, "sync-demo", digest, blobs);
    expect(gets).toBe(before);
    expect(fileURLToPath(url)).toBe(join(dir, "sync-demo", digest.slice(0, 16), "dist/index.mjs"));
  });

  it("本地目录不完整（文件被改或丢了）时重新解包", async () => {
    const root = join(dir, "sync-demo", digest.slice(0, 16));
    await writeFile(join(root, "dist/index.mjs"), "tampered");
    const before = gets;
    await syncPackage(dir, "sync-demo", digest, blobs);
    expect(gets).toBe(before + 1);
    expect(await readFile(join(root, "dist/index.mjs"), "utf8")).toContain("defineExtension");
  });

  it("多出不在校验文件里的文件时也重新解包", async () => {
    const root = join(dir, "sync-demo", digest.slice(0, 16));
    await writeFile(join(root, "dist/extra.mjs"), "export default 1;");
    const before = gets;
    await syncPackage(dir, "sync-demo", digest, blobs);
    expect(gets).toBe(before + 1);
    expect(await readdir(join(root, "dist"))).toEqual(["index.mjs"]);
  });

  it("解包期间同机另一个进程先换入了完整目录：以它为准，不删", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inGet = new Promise<void>((r) => {
      entered = r;
    });
    const slow = {
      get: async () => {
        entered();
        await gate;
        return bytes;
      },
    };
    const a = syncPackage(dir, "race-demo", digest, slow);
    await inGet;
    // 另一个进程在 a 取包期间完成同步
    const urlB = await syncPackage(dir, "race-demo", digest, blobs);
    const root = join(dir, "race-demo", digest.slice(0, 16));
    const ino = (await stat(root)).ino;
    release();
    expect(await a).toBe(urlB);
    expect((await stat(root)).ino).toBe(ino);
    expect(await readdir(join(dir, "race-demo"))).toEqual([digest.slice(0, 16)]);
  });

  it("没有校验文件的残留目录（上次解到一半）被替换", async () => {
    const root = join(dir, "sync-demo", digest.slice(0, 16));
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/index.mjs"), "partial");
    await syncPackage(dir, "sync-demo", digest, blobs);
    expect((await readdir(root)).sort()).toContain(".capybara-package.json");
  });

  it("clearBrokenRoot never deletes a root that became complete after the caller's check", async () => {
    // Another process on the same volume renamed its complete directory in between our intact()
    // check and the swap: it must survive (same inode), and nothing is left aside.
    const url = await syncPackage(dir, "sync-demo", digest, blobs);
    const root = join(dir, "sync-demo", digest.slice(0, 16));
    const ino = (await stat(root)).ino;
    const kept = await clearBrokenRoot(root, digest);
    expect(kept?.sha256).toBe(digest);
    expect((await stat(root)).ino).toBe(ino);
    expect(await readdir(join(dir, "sync-demo"))).toEqual([digest.slice(0, 16)]);
    expect(await syncPackage(dir, "sync-demo", digest, blobs)).toBe(url);
  });

  it("clearBrokenRoot moves a broken root aside and deletes it; a missing root is a no-op", async () => {
    const root = join(dir, "sync-demo", digest.slice(0, 16));
    await writeFile(join(root, "extra.txt"), "not in the marker");
    expect(await clearBrokenRoot(root, digest)).toBeUndefined();
    expect(await readdir(join(dir, "sync-demo"))).toEqual([]);
    expect(await clearBrokenRoot(root, digest)).toBeUndefined();
  });

  it("名字或 sha256 不合法时拒绝（不落盘）", async () => {
    await expect(syncPackage(dir, "../evil", digest, blobs)).rejects.toThrow(/plugin name/);
    await expect(syncPackage(dir, "sync-demo", "abc", blobs)).rejects.toThrow(/sha256/);
    expect((await readdir(dir)).sort()).toEqual(["race-demo", "sync-demo"]);
  });

  it("取到的包与 sha256 不符时拒绝", async () => {
    const other = await pluginTgz({ name: "sync-demo", version: "1.0.1" });
    const fake = sha(other);
    const liar = { get: async () => bytes };
    await expect(syncPackage(dir, "sync-demo", fake, liar)).rejects.toThrow(/sha256/);
    await expect(lstat(join(dir, "sync-demo", fake.slice(0, 16)))).rejects.toThrow();
  });
});
