import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  fitImageForModel,
  MODEL_IMAGE_KEEP_BYTES,
  MODEL_IMAGE_MAX_EDGE,
  modelImageKey,
  parseModelImage,
  serializeModelImage,
} from "../../src/conversations/model-image.js";

/** A PNG of random pixels (incompressible, so its size follows its dimensions). */
async function noisePng(width: number, height: number, alpha = false): Promise<Uint8Array> {
  const channels = alpha ? 4 : 3;
  const pixels = randomBytes(width * height * channels);
  if (alpha) for (let i = 3; i < pixels.length; i += 4) pixels[i] = i % 8 === 3 ? 0 : 255;
  return new Uint8Array(await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer());
}

describe("fitImageForModel", () => {
  it("scales a large opaque PNG to the max edge as a smaller JPEG", async () => {
    const data = await noisePng(3000, 1500);
    expect(data.byteLength).toBeGreaterThan(MODEL_IMAGE_KEEP_BYTES);
    const out = await fitImageForModel({ mediaType: "image/png", data });
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.data.byteLength).toBeLessThan(data.byteLength);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([MODEL_IMAGE_MAX_EDGE, 1024]);
  });

  it("re-encodes a heavy image within the max edge without resizing it", async () => {
    const data = await noisePng(1000, 800);
    expect(data.byteLength).toBeGreaterThan(MODEL_IMAGE_KEEP_BYTES);
    const out = await fitImageForModel({ mediaType: "image/png", data });
    expect(out.mediaType).toBe("image/jpeg");
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 800]);
  });

  it("keeps transparency as WebP", async () => {
    const data = await noisePng(2500, 1000, true);
    const out = await fitImageForModel({ mediaType: "image/png", data });
    expect(out.mediaType).toBe("image/webp");
    const meta = await sharp(out.data).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(Math.max(meta.width, meta.height)).toBe(MODEL_IMAGE_MAX_EDGE);
  });

  it("returns small images, GIFs and undecodable bytes unchanged", async () => {
    const small = { mediaType: "image/png", data: await noisePng(200, 100) };
    expect(await fitImageForModel(small)).toBe(small);
    const gif = { mediaType: "image/gif", data: new Uint8Array(2_000_000) };
    expect(await fitImageForModel(gif)).toBe(gif);
    const broken = { mediaType: "image/png", data: new Uint8Array(2_000_000) };
    expect(await fitImageForModel(broken)).toBe(broken);
  });

  it("gives the same bytes for the same input", async () => {
    const data = await noisePng(2200, 900);
    const a = await fitImageForModel({ mediaType: "image/png", data });
    const b = await fitImageForModel({ mediaType: "image/png", data });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it("round-trips a cached copy and rejects other values", () => {
    const copy = { mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) };
    expect(parseModelImage(serializeModelImage(copy))).toEqual(copy);
    expect(parseModelImage(undefined)).toBeNull();
    expect(parseModelImage("garbage")).toBeNull();
    expect(parseModelImage("text/html\nAAAA")).toBeNull();
    expect(modelImageKey("o1", { id: "a1", etag: "e1", size: 5 })).toBe("model_image:v1:o1:a1:e1");
    expect(modelImageKey("o1", { id: "a1", etag: null, size: 5 })).toBe(
      "model_image:v1:o1:a1:size-5",
    );
  });
});
