import { describe, expect, it } from "vitest";
import { DEFAULT_ATTACHMENT_EXTENSIONS, KernelConfigSchema } from "../../src/config/schema.js";
import {
  ATTACHMENT_DOWNLOAD_CACHE_SECONDS,
  ATTACHMENT_DOWNLOAD_TTL_SECONDS,
  normalizeContentType,
  sniffMatches,
} from "../../src/conversations/attachments.service.js";
import {
  acceptedContent,
  isImageContentType,
  isMediaContentType,
} from "../../src/conversations/media-types.js";
import { PrefixedStorage } from "../../src/storage/storage.service.js";
import { attachmentsFor } from "../helpers/conversations.js";

const config = KernelConfigSchema.parse({
  db: { url: "postgres://x" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("AttachmentsService", () => {
  it("没有对象存储提供方：上传、finalize、下载都是 storage.unavailable（503）", async () => {
    const svc = attachmentsFor({
      storage: new PrefixedStorage({ provider: () => undefined, plugins: async () => [] }),
      config: () => config,
      canAccessConversation: async () => true,
      log: { info() {}, warn() {} },
    });
    const orgId = "00000000-0000-4000-8000-000000000001";
    for (const p of [
      svc.create(orgId, "acc", { name: "a.png", contentType: "image/png", size: 1 }),
      svc.finalize(orgId, "acc", "id"),
      svc.downloadUrl(orgId, "acc", "id"),
    ]) {
      await expect(p).rejects.toMatchObject({ code: "storage.unavailable", status: 503 });
    }
    expect(await svc.deleteExpired()).toBe(0);
  });

  it("limits：允许的类型、单个上限（图片另受 MEDIA_LIMITS 限制）与每条条数；没有存储也能读", () => {
    const mk = (attachments: Record<string, unknown>) =>
      attachmentsFor({
        storage: new PrefixedStorage({ provider: () => undefined, plugins: async () => [] }),
        config: () =>
          KernelConfigSchema.parse({
            db: { url: "postgres://x" },
            redis: { url: "redis://x" },
            masterKey: Buffer.alloc(32, 7).toString("base64"),
            attachments,
          }),
        canAccessConversation: async () => true,
        log: { info() {}, warn() {} },
      });
    expect(mk({}).limits()).toEqual({
      types: [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "application/json",
      ],
      extensions: [...DEFAULT_ATTACHMENT_EXTENSIONS],
      maxBytes: 20_971_520,
      imageMaxBytes: 5_242_880,
      maxPerMessage: 10,
      requestMediaBytes: 20_971_520,
      available: false,
    });
    expect(
      mk({
        maxBytes: 1000,
        allowedTypes: ["image/png"],
        maxPerMessage: 3,
        requestMediaBytes: 4000,
      }).limits(),
    ).toEqual({
      types: ["image/png"],
      extensions: [...DEFAULT_ATTACHMENT_EXTENSIONS],
      maxBytes: 1000,
      imageMaxBytes: 1000,
      maxPerMessage: 3,
      requestMediaBytes: 4000,
      available: false,
    });
  });

  it("accepts a source file by extension whatever its declared content type says", () => {
    const cfg = { allowedTypes: ["image/png"], allowedExtensions: ["py", "html", "docx"] };
    expect(acceptedContent(cfg, "main.py", "application/octet-stream")).toBe(true);
    expect(acceptedContent(cfg, "page.html", "text/html")).toBe(true);
    expect(
      acceptedContent(
        cfg,
        "续约.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    // a type on the list needs no extension
    expect(acceptedContent(cfg, "shot", "image/png")).toBe(true);
    // the extension is case-insensitive; a bare or unknown name is not accepted by accident
    expect(acceptedContent(cfg, "MAIN.PY", "text/plain")).toBe(true);
    expect(acceptedContent(cfg, "a.exe", "application/x-msdownload")).toBe(false);
    expect(acceptedContent(cfg, "noextension", "application/octet-stream")).toBe(false);
    expect(acceptedContent(cfg, "trailing.", "application/octet-stream")).toBe(false);
    expect(acceptedContent(cfg, "a.notanextension", "application/octet-stream")).toBe(false);
  });

  it("配置要求 maxBytes ≤ requestMediaBytes（单个附件总能放进一次请求）", () => {
    const base = {
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    };
    const bad = KernelConfigSchema.safeParse({
      ...base,
      attachments: { maxBytes: 2000, requestMediaBytes: 1000 },
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("attachments.maxBytes must be at most");
    expect(
      KernelConfigSchema.safeParse({
        ...base,
        attachments: { maxBytes: 1000, requestMediaBytes: 1000 },
      }).success,
    ).toBe(true);
    // 只调小预算、不调 maxBytes（默认 20 MiB）同样被拒
    expect(
      KernelConfigSchema.safeParse({ ...base, attachments: { requestMediaBytes: 1000 } }).success,
    ).toBe(false);
  });

  it("requestMediaBytes 不超过 24 MiB（base64 膨胀后仍在常见的 32 MB 请求上限内）", () => {
    const base = {
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    };
    const at = (n: number) =>
      KernelConfigSchema.safeParse({ ...base, attachments: { requestMediaBytes: n } }).success;
    expect(at(25_165_824)).toBe(true);
    expect(at(25_165_825)).toBe(false);
  });

  it("allowedTypes 只收小写的 type/subtype，不带参数", () => {
    const base = {
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    };
    const ok = (allowedTypes: string[]) =>
      KernelConfigSchema.safeParse({ ...base, attachments: { allowedTypes } }).success;
    expect(ok(["application/json", "text/plain"])).toBe(true);
    expect(ok(["Application/JSON"])).toBe(false);
    expect(ok(["text/plain; charset=utf-8"])).toBe(false);
    expect(ok(["image"])).toBe(false);
    expect(ok([])).toBe(false);
  });

  it("defaults: 20 MiB, 13 types, 10 per message, 24 hours, 20 MiB of media per request, read copies", () => {
    expect(config.attachments).toEqual({
      maxBytes: 20_971_520,
      allowedTypes: [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "application/json",
      ],
      allowedExtensions: [...DEFAULT_ATTACHMENT_EXTENSIONS],
      maxPerMessage: 10,
      unboundTtlHours: 24,
      requestMediaBytes: 20_971_520,
      readImagesPerRequest: 6,
      readMaxBytesPerConversation: 536_870_912,
      readPurgeAfterHours: 24,
    });
  });
});

describe("下载跳转", () => {
  it("预签名有效期不短于 302 的浏览器缓存时间", () => {
    expect(ATTACHMENT_DOWNLOAD_CACHE_SECONDS).toBe(60);
    expect(ATTACHMENT_DOWNLOAD_TTL_SECONDS).toBeGreaterThanOrEqual(
      ATTACHMENT_DOWNLOAD_CACHE_SECONDS,
    );
  });
});

describe("类型核对", () => {
  it("normalizeContentType 去参数、转小写", () => {
    expect(normalizeContentType("Text/Plain; charset=utf-8")).toBe("text/plain");
  });

  it("文件开头的签名与声明的类型相符才通过", () => {
    const b = (...x: number[]) => new Uint8Array(x);
    const s = (t: string) => new TextEncoder().encode(t);
    expect(sniffMatches("image/png", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
    expect(sniffMatches("image/png", b(0xff, 0xd8, 0xff))).toBe(false);
    expect(sniffMatches("image/jpeg", b(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(sniffMatches("image/gif", s("GIF89a..."))).toBe(true);
    expect(sniffMatches("image/webp", s("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe(true);
    expect(sniffMatches("image/webp", s("RIFF\u0000\u0000\u0000\u0000WAVE"))).toBe(false);
    expect(sniffMatches("application/pdf", s("%PDF-1.7\n"))).toBe(true);
    expect(sniffMatches("application/pdf", s("<html>"))).toBe(false);
    expect(sniffMatches("text/plain", s("hello"))).toBe(true);
    expect(sniffMatches("text/csv", b(0x61, 0x00, 0x62))).toBe(false);
    // an OOXML file is a zip: compressed bytes usually contain NUL, the signature still has to match
    expect(sniffMatches(XLSX, b(0x50, 0x4b, 0x03, 0x04, 0x00, 0x01))).toBe(true);
    expect(sniffMatches(XLSX, s("not a zip"))).toBe(false);
    // a mismatch is still refused in both directions
    expect(sniffMatches(XLSX, b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false);
    expect(sniffMatches("image/png", b(0x50, 0x4b, 0x03, 0x04))).toBe(false);
    expect(sniffMatches("application/json", s('{"a":1}'))).toBe(true);
    expect(sniffMatches("application/json", b(0x7b, 0x00, 0x7d))).toBe(false);
    // a deployment-added type has no signature to check
    expect(sniffMatches("application/x-custom", b(0x00, 0x01))).toBe(true);
  });
});

describe("媒体类型", () => {
  it("图片走 image 块，PDF 与文本走 document 块，其余为 file 块", () => {
    expect(isImageContentType("image/png")).toBe(true);
    expect(isImageContentType("application/pdf")).toBe(false);
    expect(isMediaContentType("image/webp")).toBe(true);
    expect(isMediaContentType("application/pdf")).toBe(true);
    expect(isMediaContentType("text/csv")).toBe(true);
    expect(isMediaContentType("application/zip")).toBe(false);
    expect(
      isMediaContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe(false);
  });
});
