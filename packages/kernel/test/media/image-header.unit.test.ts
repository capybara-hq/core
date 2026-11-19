import { describe, expect, it } from "vitest";
import { sniffImage } from "../../src/media/image-header.js";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(w: number, h: number): Uint8Array {
  return bytes(PNG_SIG, be32(13), ascii("IHDR"), be32(w), be32(h), [8, 2, 0, 0, 0]);
}

function jpeg(sof: number, w: number, h: number): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0],
    be16(4),
    [0, 0],
    [0xff, 0xc4], // DHT: must be skipped
    be16(4),
    [0, 0],
    [0xff, sof],
    be16(11),
    [8],
    be16(h),
    be16(w),
    [1, 1, 0x11, 0],
  );
}

function webp(chunk: number[]): Uint8Array {
  return bytes(ascii("RIFF"), le32(4 + chunk.length), ascii("WEBP"), chunk);
}

describe("sniffImage", () => {
  it("reads PNG dimensions", () => {
    expect(sniffImage(png(3, 2))).toEqual({ mediaType: "image/png", width: 3, height: 2 });
  });

  it("returns the type without dimensions for a truncated PNG", () => {
    expect(sniffImage(bytes(PNG_SIG))).toEqual({ mediaType: "image/png" });
  });

  it("reads baseline and progressive JPEG dimensions", () => {
    expect(sniffImage(jpeg(0xc0, 7, 5))).toEqual({ mediaType: "image/jpeg", width: 7, height: 5 });
    expect(sniffImage(jpeg(0xc2, 300, 200))).toEqual({
      mediaType: "image/jpeg",
      width: 300,
      height: 200,
    });
  });

  it("returns the type for a JPEG without a frame header", () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4]))).toEqual({ mediaType: "image/jpeg" });
  });

  it("reads GIF logical screen size", () => {
    expect(sniffImage(bytes(ascii("GIF89a"), le16(5), le16(4), [0, 0, 0]))).toEqual({
      mediaType: "image/gif",
      width: 5,
      height: 4,
    });
  });

  it("reads WebP lossy, lossless and extended sizes", () => {
    const vp8 = [...ascii("VP8 "), ...le32(10), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(9), ...le16(6)];
    expect(sniffImage(webp(vp8))).toEqual({ mediaType: "image/webp", width: 9, height: 6 });

    const bits = (11 - 1) | ((13 - 1) << 14);
    const vp8l = [...ascii("VP8L"), ...le32(5), 0x2f, ...le32(bits)];
    expect(sniffImage(webp(vp8l))).toEqual({ mediaType: "image/webp", width: 11, height: 13 });

    const w = 1000 - 1;
    const h = 2000 - 1;
    const vp8x = [
      ...ascii("VP8X"),
      ...le32(10),
      0,
      0,
      0,
      0,
      w & 255,
      (w >> 8) & 255,
      (w >> 16) & 255,
      h & 255,
      (h >> 8) & 255,
      (h >> 16) & 255,
    ];
    expect(sniffImage(webp(vp8x))).toEqual({ mediaType: "image/webp", width: 1000, height: 2000 });
  });

  it("returns the type for a truncated WebP", () => {
    expect(sniffImage(bytes(ascii("RIFF"), le32(4), ascii("WEBP")))).toEqual({
      mediaType: "image/webp",
    });
  });

  it("returns null for other formats and short input", () => {
    expect(sniffImage(Uint8Array.from(ascii("%PDF-1.7")))).toBeNull();
    expect(
      sniffImage(Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))),
    ).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(bytes([0xff]))).toBeNull();
  });
});
