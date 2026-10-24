import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type FakeNpmRegistry, startFakeNpmRegistry } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchNpmPackage,
  IntegrityMismatchError,
  NpmFetchError,
  PackageTooLargeError,
} from "../../src/packages/npm.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const signal = () => AbortSignal.timeout(10_000);

const A1 = bytes("tgz of a 1.0.0");
const A2 = bytes("tgz of a 2.0.0-beta");
const BIG = new Uint8Array(4096).fill(7);

let reg: FakeNpmRegistry;
let other: { url: string; close(): Promise<void> };

beforeAll(async () => {
  // 另一个源上的 tarball（测「不同源」）
  const s = createServer((_req, res) => res.writeHead(200).end(Buffer.from(A1)));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  other = {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
  reg = await startFakeNpmRegistry({
    packages: [
      { name: "@acme/plugin-a", version: "1.0.0", tgz: A1, tags: ["latest"] },
      { name: "@acme/plugin-a", version: "2.0.0-beta", tgz: A2, tags: ["next"] },
      { name: "bad-integrity", version: "1.0.0", tgz: A1, integrity: sri(bytes("other")) },
      { name: "elsewhere", version: "1.0.0", tgz: A1, tarballUrl: `${other.url}/x.tgz` },
      { name: "redirected", version: "1.0.0", tgz: A1, redirectTarball: true },
      { name: "huge", version: "1.0.0", tgz: BIG },
    ],
  });
});
afterAll(async () => {
  await reg?.stop();
  await other?.close();
});

const cfg = (over: Partial<Parameters<typeof fetchNpmPackage>[0]> = {}) => ({
  registry: reg.url,
  maxBytes: 1024,
  ...over,
});

describe("fetchNpmPackage", () => {
  it("取 latest 版本，按 dist.integrity 校验，返回字节、版本与 integrity", async () => {
    const r = await fetchNpmPackage(cfg(), "@acme/plugin-a", undefined, signal());
    expect(r.version).toBe("1.0.0");
    expect(Buffer.from(r.bytes).equals(Buffer.from(A1))).toBe(true);
    expect(r.integrity).toBe(sri(A1));
    // scope 包名按 npm 的写法编码
    expect(reg.requests).toContain("/@acme%2fplugin-a");
  });

  it("指定版本或 dist-tag", async () => {
    expect((await fetchNpmPackage(cfg(), "@acme/plugin-a", "2.0.0-beta", signal())).version).toBe(
      "2.0.0-beta",
    );
    expect((await fetchNpmPackage(cfg(), "@acme/plugin-a", "next", signal())).version).toBe(
      "2.0.0-beta",
    );
  });

  it("没有该包 / 版本 → NpmFetchError", async () => {
    await expect(fetchNpmPackage(cfg(), "nope", undefined, signal())).rejects.toBeInstanceOf(
      NpmFetchError,
    );
    await expect(
      fetchNpmPackage(cfg(), "@acme/plugin-a", "9.9.9", signal()),
    ).rejects.toBeInstanceOf(NpmFetchError);
  });

  it("包名不合法 → NpmFetchError，不发请求", async () => {
    const before = reg.requests.length;
    await expect(fetchNpmPackage(cfg(), "../etc", undefined, signal())).rejects.toBeInstanceOf(
      NpmFetchError,
    );
    expect(reg.requests.length).toBe(before);
  });

  it("integrity 不符 → IntegrityMismatchError（属于 NpmFetchError）", async () => {
    const e = await fetchNpmPackage(cfg(), "bad-integrity", undefined, signal()).catch((x) => x);
    expect(e).toBeInstanceOf(IntegrityMismatchError);
    expect(e).toBeInstanceOf(NpmFetchError);
  });

  it("tarball 与 registry 不同源 → 拒绝，不去下载", async () => {
    await expect(fetchNpmPackage(cfg(), "elsewhere", undefined, signal())).rejects.toThrow(
      /origin/,
    );
  });

  it("不跟随重定向", async () => {
    await expect(fetchNpmPackage(cfg(), "redirected", undefined, signal())).rejects.toThrow(
      /redirect/,
    );
  });

  it("超过 maxBytes → PackageTooLargeError", async () => {
    await expect(fetchNpmPackage(cfg(), "huge", undefined, signal())).rejects.toBeInstanceOf(
      PackageTooLargeError,
    );
  });

  it("令牌只发给 registry 源", async () => {
    const start = reg.requests.length;
    await fetchNpmPackage(cfg({ token: "npm-secret" }), "@acme/plugin-a", undefined, signal());
    expect(reg.authorizations.slice(start)).toEqual(["Bearer npm-secret", "Bearer npm-secret"]);
  });

  it("expectedIntegrity：只认它（npm 元数据里的不符也不管），不符抛 IntegrityMismatchError", async () => {
    const ok = await fetchNpmPackage(cfg(), "bad-integrity", undefined, signal(), {
      expectedIntegrity: sri(A1),
    });
    expect(ok.integrity).toBe(sri(A1));
    await expect(
      fetchNpmPackage(cfg(), "@acme/plugin-a", "1.0.0", signal(), {
        expectedIntegrity: sri(bytes("x")),
      }),
    ).rejects.toBeInstanceOf(IntegrityMismatchError);
  });

  it("tarballUrl：必须是 https，回环 http 只在 allowInsecureLoopback 时允许", async () => {
    const tarballUrl = `${other.url}/x.tgz`;
    const o = { expectedIntegrity: sri(A1), tarballUrl };
    await expect(fetchNpmPackage(cfg(), "elsewhere", "1.0.0", signal(), o)).rejects.toThrow(
      /https/,
    );
    const r = await fetchNpmPackage(
      cfg({ allowInsecureLoopback: true }),
      "elsewhere",
      "1.0.0",
      signal(),
      o,
    );
    expect(Buffer.from(r.bytes).equals(Buffer.from(A1))).toBe(true);
    await expect(
      fetchNpmPackage(cfg(), "elsewhere", "1.0.0", signal(), {
        tarballUrl,
      }),
    ).rejects.toThrow(/expectedIntegrity/);
  });

  it("中止信号 → 拒绝", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchNpmPackage(cfg(), "@acme/plugin-a", undefined, ac.signal),
    ).rejects.toBeInstanceOf(NpmFetchError);
  });
});
