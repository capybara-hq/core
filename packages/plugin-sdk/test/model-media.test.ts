import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ContentBlock,
  MEDIA_LIMITS,
  type MediaSource,
  type ModelInfo,
  validateMediaBlock,
} from "../src/index.js";

/** n 字节内容的合法 base64（全 0 字节）。 */
const b64 = (bytes: number) => Buffer.alloc(bytes).toString("base64");

const image = (over: Record<string, unknown> = {}) => ({
  type: "image",
  mediaType: "image/png",
  source: { kind: "base64", data: b64(16) },
  ...over,
});
const doc = (over: Record<string, unknown> = {}) => ({
  type: "document",
  mediaType: "application/pdf",
  source: { kind: "base64", data: b64(16) },
  ...over,
});

describe("MEDIA_LIMITS", () => {
  it("图片 5 MiB、文档 32 MiB", () => {
    expect(MEDIA_LIMITS).toEqual({ imageBytes: 5_242_880, documentBytes: 33_554_432 });
  });
});

describe("validateMediaBlock", () => {
  it("合法的 base64 图片 / 文档与 ref 引用通过", () => {
    expect(validateMediaBlock(image())).toEqual([]);
    expect(validateMediaBlock(image({ name: "a.png" }))).toEqual([]);
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(validateMediaBlock(image({ mediaType: t }))).toEqual([]);
    }
    for (const t of ["application/pdf", "text/plain", "text/markdown", "text/csv"]) {
      expect(validateMediaBlock(doc({ mediaType: t }))).toEqual([]);
    }
    expect(validateMediaBlock(doc({ source: { kind: "ref", attachmentId: "att_1" } }))).toEqual([]);
  });

  it("不是对象、不是媒体块：报错", () => {
    expect(validateMediaBlock(null)).not.toEqual([]);
    expect(validateMediaBlock("x")).not.toEqual([]);
    expect(validateMediaBlock({ type: "text", text: "x" })).not.toEqual([]);
  });

  it("类型不在列表里：报错", () => {
    expect(validateMediaBlock(image({ mediaType: "image/svg+xml" })).join()).toMatch(/mediaType/);
    expect(validateMediaBlock(image({ mediaType: "application/pdf" }))).not.toEqual([]);
    expect(validateMediaBlock(doc({ mediaType: "image/png" }))).not.toEqual([]);
    expect(validateMediaBlock(doc({ mediaType: "application/zip" }))).not.toEqual([]);
    expect(validateMediaBlock(doc({ mediaType: undefined }))).not.toEqual([]);
  });

  it("base64 非法：报错", () => {
    for (const data of ["", "abc", "ab$d", "a===", "ab=c", "YQ==YQ==", " YWJj", "YWJj\n"]) {
      const errs = validateMediaBlock(image({ source: { kind: "base64", data } }));
      expect(errs.join(), data).toMatch(/base64/);
    }
    expect(validateMediaBlock(image({ source: { kind: "base64", data: 1 } }))).not.toEqual([]);
  });

  it("超过 MEDIA_LIMITS：报错；恰好等于上限通过", () => {
    expect(
      validateMediaBlock(image({ source: { kind: "base64", data: b64(MEDIA_LIMITS.imageBytes) } })),
    ).toEqual([]);
    const big = validateMediaBlock(
      image({ source: { kind: "base64", data: b64(MEDIA_LIMITS.imageBytes + 1) } }),
    );
    expect(big.join()).toMatch(/5242880/);
    expect(
      validateMediaBlock(
        doc({ source: { kind: "base64", data: b64(MEDIA_LIMITS.documentBytes + 1) } }),
      ).join(),
    ).toMatch(/33554432/);
    // 图片上限比文档小：6 MiB 的 PDF 可以
    expect(
      validateMediaBlock(doc({ source: { kind: "base64", data: b64(6 * 1024 * 1024) } })),
    ).toEqual([]);
  });

  it("source 不合法 / name 不合法：报错", () => {
    expect(validateMediaBlock(image({ source: undefined }))).not.toEqual([]);
    expect(validateMediaBlock(image({ source: { kind: "url", url: "https://x" } }))).not.toEqual(
      [],
    );
    expect(validateMediaBlock(image({ source: { kind: "ref", attachmentId: "" } }))).not.toEqual(
      [],
    );
    expect(validateMediaBlock(image({ name: 1 }))).not.toEqual([]);
  });
});

describe("类型", () => {
  it("ContentBlock 含 image / document，source 为 base64 或 ref", () => {
    expectTypeOf<Extract<ContentBlock, { type: "image" }>["source"]>().toEqualTypeOf<MediaSource>();
    expectTypeOf<Extract<ContentBlock, { type: "document" }>["mediaType"]>().toEqualTypeOf<
      "application/pdf" | "text/plain" | "text/markdown" | "text/csv"
    >();
    expectTypeOf<MediaSource>().toEqualTypeOf<
      { kind: "base64"; data: string } | { kind: "ref"; attachmentId: string }
    >();
  });

  it("ModelInfo.capabilities.documents 可选", () => {
    expectTypeOf<ModelInfo["capabilities"]["documents"]>().toEqualTypeOf<boolean | undefined>();
  });
});
