import { randomUUID } from "node:crypto";
import { CapabilityUnavailableError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { StorageKeyError, StorageService } from "../../src/storage/storage.service.js";
import { MemoryObjectStore } from "./memory-store.js";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
/** 字面的 `${`（直接写在字符串里会被 lint 当成误写的模板占位符）。 */
const DB = "\u0024\u007b";
const bytes = (s: string) => new TextEncoder().encode(s);
const text = async (b: ReadableStream<Uint8Array>) => new Response(b).text();

const setup = (plugins: string[] = ["aa", "bb"]) => {
  const mem = new MemoryObjectStore();
  const svc = new StorageService({ provider: () => mem, plugins: async () => plugins });
  return { mem, svc };
};

describe("StorageService 可用性", () => {
  it("没有提供方：available 为 false，各方法 reject storage.unavailable", async () => {
    const svc = new StorageService({ provider: () => undefined, plugins: async () => [] });
    expect(svc.available).toBe(false);
    const s = svc.forPlugin("aa");
    await expect(s.head(ORG_A, "k")).rejects.toThrow(CapabilityUnavailableError);
    await expect(s.put(ORG_A, "k", bytes("x"), { contentType: "text/plain" })).rejects.toThrow(
      /storage\.unavailable/,
    );
    await expect(svc.kernel(ORG_A).head("k")).rejects.toThrow(/storage\.unavailable/);
    await expect(svc.deleteOrg(ORG_A)).rejects.toThrow(/storage\.unavailable/);
  });

  it("提供方后来才就绪（按调用时取）：available 跟着变", async () => {
    let p: MemoryObjectStore | undefined;
    const svc = new StorageService({ provider: () => p, plugins: async () => [] });
    expect(svc.available).toBe(false);
    p = new MemoryObjectStore();
    expect(svc.available).toBe(true);
  });
});

describe("前缀隔离", () => {
  it("插件键落在 plugins/<插件>/<orgId>/ 下，返回的键不带前缀", async () => {
    const { mem, svc } = setup();
    const a = svc.forPlugin("aa");
    const h = await a.put(ORG_A, "dir/x.txt", bytes("hi"), { contentType: "text/plain" });
    expect(h.key).toBe("dir/x.txt");
    expect([...mem.objects.keys()]).toEqual([`plugins/aa/${ORG_A}/dir/x.txt`]);
    expect((await a.head(ORG_A, "dir/x.txt"))?.key).toBe("dir/x.txt");
    const got = await a.get(ORG_A, "dir/x.txt");
    expect(got?.head.key).toBe("dir/x.txt");
    expect(await text(got?.body as ReadableStream<Uint8Array>)).toBe("hi");
  });

  it("插件 A 读不到插件 B；也读不到别的组织", async () => {
    const { svc } = setup();
    const a = svc.forPlugin("aa");
    const b = svc.forPlugin("bb");
    await a.put(ORG_A, "secret", bytes("a"), { contentType: "text/plain" });
    expect(await b.head(ORG_A, "secret")).toBeNull();
    expect(await b.get(ORG_A, "secret")).toBeNull();
    expect((await b.list(ORG_A, "")).items).toEqual([]);
    expect(await a.head(ORG_B, "secret")).toBeNull();
    expect((await a.list(ORG_B, "")).items).toEqual([]);
    // B 删不到 A 的对象
    await b.delete(ORG_A, "secret");
    expect(await b.deletePrefix(ORG_A, "")).toBe(0);
    expect(await a.head(ORG_A, "secret")).not.toBeNull();
  });

  it("list 去掉前缀、分页 cursor 往返可用", async () => {
    const { svc } = setup();
    const a = svc.forPlugin("aa");
    for (const k of ["p/1", "p/2", "p/3", "q/1"]) {
      await a.put(ORG_A, k, bytes(k), { contentType: "text/plain" });
    }
    const p1 = await a.list(ORG_A, "p/", { limit: 2 });
    expect(p1.items.map((i) => i.key)).toEqual(["p/1", "p/2"]);
    const p2 = await a.list(ORG_A, "p/", { limit: 2, cursor: p1.cursor as string });
    expect(p2.items.map((i) => i.key)).toEqual(["p/3"]);
    expect(p2.cursor).toBeUndefined();
    expect((await a.list(ORG_A, "")).items.map((i) => i.key)).toEqual(["p/1", "p/2", "p/3", "q/1"]);
  });

  it("presign 用加了前缀的键", async () => {
    const { mem, svc } = setup();
    const a = svc.forPlugin("aa");
    await a.presignGet(ORG_A, "f", { ttlSeconds: 60 });
    const u = await a.presignPut(ORG_A, "g", {
      contentType: "text/plain",
      maxSize: 1,
      ttlSeconds: 60,
    });
    expect(u.method).toBe("POST");
    expect(mem.calls.slice(-2)).toEqual([
      { method: "presignGet", key: `plugins/aa/${ORG_A}/f` },
      { method: "presignPut", key: `plugins/aa/${ORG_A}/g` },
    ]);
  });

  it("内核用 kernel/<orgId>/ 前缀", async () => {
    const { mem, svc } = setup();
    const k = svc.kernel(ORG_A);
    await k.put("attachments/1", bytes("x"), { contentType: "text/plain" });
    expect([...mem.objects.keys()]).toEqual([`kernel/${ORG_A}/attachments/1`]);
    expect((await k.list("")).items.map((i) => i.key)).toEqual(["attachments/1"]);
    expect(await svc.forPlugin("aa").head(ORG_A, "attachments/1")).toBeNull();
  });

  it("提供方返回了前缀之外的键（不该发生）时被过滤掉", async () => {
    const { mem, svc } = setup();
    mem.objects.set(`plugins/aa/${ORG_A}x/evil`, { data: bytes("e"), contentType: "" });
    const orig = mem.list.bind(mem);
    mem.list = async (_prefix, opts) => orig(`plugins/aa/${ORG_A}`, opts);
    expect((await svc.forPlugin("aa").list(ORG_A, "")).items).toEqual([]);
  });
});

describe("键校验", () => {
  const bad = [
    ["空键", ""],
    ["以 / 开头", "/etc/passwd"],
    ["../ 段", "../b/x"],
    ["中间的 .. 段", "a/../../b"],
    [". 段", "a/./b"],
    ["反斜杠", "a\\b"],
    ["控制字符", "a\u0000b"],
    ["换行", "a\nb"],
    ["DEL", "a\u007fb"],
    ["超长", "x".repeat(1024)],
    // POST 策略里的 ${filename} 等变量会被存储端替换成上传方给的文件名
    ["变量 filename", `a/${DB}filename}`],
    ["${ 出现在中间", `a${DB}b}c`],
    ["只有 ${", DB],
  ] as const;

  for (const [label, key] of bad) {
    it(`拒绝${label}`, async () => {
      const { mem, svc } = setup();
      const a = svc.forPlugin("aa");
      await expect(a.put(ORG_A, key, bytes("x"), { contentType: "text/plain" })).rejects.toThrow(
        StorageKeyError,
      );
      await expect(a.get(ORG_A, key)).rejects.toThrow(StorageKeyError);
      await expect(a.presignGet(ORG_A, key, { ttlSeconds: 1 })).rejects.toThrow(StorageKeyError);
      await expect(svc.kernel(ORG_A).head(key)).rejects.toThrow(StorageKeyError);
      expect(mem.calls).toEqual([]);
    });
  }

  it("允许普通的多段键与含 .. 的文件名（不是整段）", async () => {
    const { svc } = setup();
    const a = svc.forPlugin("aa");
    await a.put(ORG_A, "a/b..c/d.txt", bytes("x"), { contentType: "text/plain" });
    await a.put(ORG_A, "中文/文件 名.pdf", bytes("x"), { contentType: "application/pdf" });
  });

  it("list / deletePrefix 的前缀按同样规则校验；空前缀表示全部", async () => {
    const { svc } = setup();
    const a = svc.forPlugin("aa");
    await expect(a.list(ORG_A, "../")).rejects.toThrow(StorageKeyError);
    await expect(a.list(ORG_A, "/")).rejects.toThrow(StorageKeyError);
    await expect(a.deletePrefix(ORG_A, "x/../../")).rejects.toThrow(StorageKeyError);
    await expect(a.list(ORG_A, "")).resolves.toEqual({ items: [] });
  });

  it("orgId 必须是 UUID", async () => {
    const { mem, svc } = setup();
    const a = svc.forPlugin("aa");
    for (const org of ["", "..", "org-1", `${ORG_A}/x`, "../kernel"]) {
      await expect(a.head(org, "k")).rejects.toThrow(StorageKeyError);
      expect(() => svc.kernel(org)).toThrow(StorageKeyError);
    }
    await expect(svc.deleteOrg("not-a-uuid")).rejects.toThrow(StorageKeyError);
    expect(mem.calls).toEqual([]);
  });

  it("list / deletePrefix 的前缀里也不能有 ${", async () => {
    const { svc } = setup();
    await expect(svc.forPlugin("aa").list(ORG_A, `a${DB}`)).rejects.toThrow(StorageKeyError);
    await expect(svc.kernel(ORG_A).deletePrefix(`${DB}x}/`)).rejects.toThrow(StorageKeyError);
  });

  it("同一组织 id 大小写不同也落到同一个前缀（统一转小写）", async () => {
    const { mem, svc } = setup();
    const upper = ORG_A.toUpperCase();
    await svc.forPlugin("aa").put(upper, "x", bytes("1"), { contentType: "text/plain" });
    await svc.kernel(upper).put("y", bytes("1"), { contentType: "text/plain" });
    expect([...mem.objects.keys()].sort()).toEqual(
      [`kernel/${ORG_A}/y`, `plugins/aa/${ORG_A}/x`].sort(),
    );
    expect(await svc.forPlugin("aa").head(ORG_A, "x")).not.toBeNull();
    await svc.deleteOrg(upper);
    expect(mem.objects.size).toBe(0);
  });

  it("预签名的 ttlSeconds 被限制在 1..604800（7 天）", async () => {
    const { mem, svc } = setup();
    const a = svc.forPlugin("aa");
    await a.presignGet(ORG_A, "f", { ttlSeconds: 0 });
    expect(mem.lastTtl).toBe(1);
    await a.presignGet(ORG_A, "f", { ttlSeconds: 10_000_000 });
    expect(mem.lastTtl).toBe(604_800);
    await a.presignPut(ORG_A, "f", { contentType: "text/plain", maxSize: 1, ttlSeconds: -5 });
    expect(mem.lastTtl).toBe(1);
    await svc.kernel(ORG_A).presignGet("f", { ttlSeconds: 90.7 });
    expect(mem.lastTtl).toBe(90);
    await expect(a.presignGet(ORG_A, "f", { ttlSeconds: Number.NaN })).rejects.toThrow(RangeError);
  });

  it("presignGet 的 disposition / responseContentType 原样交给提供方", async () => {
    const { mem, svc } = setup();
    const opts = {
      ttlSeconds: 60,
      downloadName: "a.png",
      disposition: "inline" as const,
      responseContentType: "image/png",
    };
    await svc.forPlugin("aa").presignGet(ORG_A, "f", opts);
    expect(mem.lastGetOpts).toEqual(opts);
    await svc.kernel(ORG_A).presignGet("f", { ...opts, disposition: "attachment" });
    expect(mem.lastGetOpts).toEqual({ ...opts, disposition: "attachment" });
  });

  it("插件名不合法时拒绝", () => {
    const { svc } = setup();
    for (const name of ["", "../a", "a/b", "A"]) {
      expect(() => svc.forPlugin(name)).toThrow(StorageKeyError);
    }
  });
});

describe("deleteOrg", () => {
  it("删除 kernel/<org>/ 与每个插件的 plugins/<插件>/<org>/，别的组织不受影响", async () => {
    const { mem, svc } = setup(["aa", "bb", "gone"]);
    for (const org of [ORG_A, ORG_B]) {
      await svc.kernel(org).put("k1", bytes("x"), { contentType: "text/plain" });
      await svc.forPlugin("aa").put(org, "a1", bytes("x"), { contentType: "text/plain" });
      await svc.forPlugin("bb").put(org, "b/1", bytes("x"), { contentType: "text/plain" });
      await svc.forPlugin("gone").put(org, "g", bytes("x"), { contentType: "text/plain" });
    }
    await svc.deleteOrg(ORG_A);
    expect([...mem.objects.keys()].sort()).toEqual(
      [
        `kernel/${ORG_B}/k1`,
        `plugins/aa/${ORG_B}/a1`,
        `plugins/bb/${ORG_B}/b/1`,
        `plugins/gone/${ORG_B}/g`,
      ].sort(),
    );
  });
});
