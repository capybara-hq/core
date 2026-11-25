import { crc32, deflateSync } from "node:zlib";
import { MEDIA_LIMITS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { renderResult } from "../../src/tools/outputs.js";
import { keptExtras } from "../../src/tools/pipeline.js";
import {
  RESULT_IMAGE_MAX_PIXELS,
  RESULT_IMAGES_MAX,
  resultImageName,
  type StoreResultImage,
  storeResultImages,
} from "../../src/tools/result-images.js";

/** A valid PNG of `width`×`height` (transparent pixels), padded with a `tEXt` chunk of `pad` bytes. */
function png(width = 2, height = 3, pad = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(pad > 0
      ? [chunk("tEXt", Buffer.concat([Buffer.from("pad\0"), Buffer.alloc(pad, 0x61)]))]
      : []),
    chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 4)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = png();
const N = PNG.length;

const image = (data: Buffer, mimeType = "image/png") => ({
  type: "image",
  mimeType,
  data: data.toString("base64"),
});

/** A store that hands out ids in order and records what it was given. */
function fakeStore(outcome?: (n: number) => Awaited<ReturnType<StoreResultImage>> | undefined) {
  const stored: { name: string; contentType: string; size: number }[] = [];
  const store: StoreResultImage = async (file) => {
    stored.push({ name: file.name, contentType: file.contentType, size: file.data.byteLength });
    const n = stored.length;
    return (
      outcome?.(n) ?? {
        ok: true,
        attachmentId: `00000000-0000-4000-8000-00000000000${n}`,
        size: file.data.byteLength,
      }
    );
  };
  return { store, stored };
}

describe("storeResultImages", () => {
  it("a result without images: nothing to store", async () => {
    const { store, stored } = fakeStore();
    const got = await storeResultImages({ content: [{ type: "text", text: "hi" }] }, "t", store);
    expect(got).toBeUndefined();
    expect(stored).toEqual([]);
  });

  it("stores each image and names it in media and in the result text", async () => {
    const { store, stored } = fakeStore();
    const result = {
      content: [
        { type: "text", text: "Screenshot 2x3." },
        image(png()),
        image(png(4, 5), "image/jpeg"),
      ],
    };
    const got = await storeResultImages(result, "browser_screenshot", store);
    expect(stored).toEqual([
      { name: "browser_screenshot.png", contentType: "image/png", size: N },
      // the sniffed type wins over the declared one
      { name: "browser_screenshot-2.png", contentType: "image/png", size: png(4, 5).length },
    ]);
    expect(got?.media).toEqual([
      {
        attachmentId: "00000000-0000-4000-8000-000000000001",
        name: "browser_screenshot.png",
        mediaType: "image/png",
        size: N,
      },
      {
        attachmentId: "00000000-0000-4000-8000-000000000002",
        name: "browser_screenshot-2.png",
        mediaType: "image/png",
        size: png(4, 5).length,
      },
    ]);
    expect(renderResult(result, got?.texts).text).toBe(
      "Screenshot 2x3.\n" +
        `[Image (image/png, ${N} B, 2×3), file_id 00000000-0000-4000-8000-000000000001]\n` +
        `[Image (image/png, ${png(4, 5).length} B, 4×5), file_id 00000000-0000-4000-8000-000000000002]`,
    );
  });

  it("says why an image is not stored, so the model never takes it as shown", async () => {
    const { store } = fakeStore((n) => (n === 1 ? { ok: false, reason: "cap" } : undefined));
    const result = {
      content: [
        image(png()),
        image(Buffer.from("GIF8 not really"), "image/svg+xml"),
        image(png(1, 1, 5 * 1024 * 1024)),
      ],
    };
    const got = await storeResultImages(result, "shot", store);
    expect(got?.media).toBeUndefined();
    expect(got?.texts).toEqual([
      `[Image (image/png, ${N} B) not stored, so not shown: this conversation reached its limit for stored images.]`,
      "[Image (image/svg+xml, 15 B) not stored, so not shown: only PNG, JPEG, GIF and WebP images are stored.]",
      "[Image (image/png, 5.0 MB) not stored, so not shown: it is over the 5 MB image limit.]",
    ]);
  });

  it("no object store, or a failed store: not stored, said so", async () => {
    const result = { content: [image(png())] };
    const none = await storeResultImages(result, "shot", undefined);
    expect(none?.texts).toEqual([
      `[Image (image/png, ${N} B) not stored, so not shown: file storage is not configured in this deployment.]`,
    ]);
    const errors: unknown[] = [];
    const failed = await storeResultImages(
      result,
      "shot",
      async () => {
        throw new Error("s3 down");
      },
      (e) => errors.push(e),
    );
    expect(failed?.texts).toEqual([
      `[Image (image/png, ${N} B) not stored, so not shown: storing it failed.]`,
    ]);
    expect(errors).toHaveLength(1);
  });

  it(`stores at most ${RESULT_IMAGES_MAX} images of one result`, async () => {
    const { store, stored } = fakeStore();
    const result = { content: Array.from({ length: RESULT_IMAGES_MAX + 1 }, () => image(png())) };
    const got = await storeResultImages(result, "shot", store);
    expect(stored).toHaveLength(RESULT_IMAGES_MAX);
    expect(got?.media).toHaveLength(RESULT_IMAGES_MAX);
    expect(got?.texts.at(-1)).toBe(
      `[Image (image/png, ${N} B) not stored, so not shown: a tool result stores at most ${RESULT_IMAGES_MAX} images.]`,
    );
  });

  it("refuses an image whose header claims more pixels than the bound, before decoding it", async () => {
    const { store, stored } = fakeStore();
    // a small, valid-looking PNG whose header says 10000×10000 (100 megapixels)
    const huge = png(1, 1);
    huge.writeUInt32BE(10_000, 16);
    huge.writeUInt32BE(10_000, 20);
    const got = await storeResultImages({ content: [image(huge)] }, "shot", store);
    expect(stored).toEqual([]);
    expect(got?.texts).toEqual([
      `[Image (image/png, ${huge.length} B) not stored, so not shown: its pixel size is missing or over the limit of ${RESULT_IMAGE_MAX_PIXELS / 1_000_000} megapixels.]`,
    ]);
  });

  it("refuses a compressible image just over the pixel bound", async () => {
    const { store, stored } = fakeStore();
    // 7000×6000 = 42 Mpx of zeros deflates to a few dozen KB
    const big = png(7000, 6000);
    expect(big.length).toBeLessThan(MEDIA_LIMITS.imageBytes);
    const got = await storeResultImages({ content: [image(big)] }, "shot", store);
    expect(stored).toEqual([]);
    expect(got?.texts[0]).toContain("its pixel size is missing or over the limit");
  });

  it("refuses a truncated image (valid magic bytes, cut body) as unreadable", async () => {
    const { store, stored } = fakeStore();
    const whole = png(64, 64);
    const cut = whole.subarray(0, whole.length - 20);
    const got = await storeResultImages({ content: [image(Buffer.from(cut))] }, "shot", store);
    expect(stored).toEqual([]);
    expect(got?.texts).toEqual([
      `[Image (image/png, ${cut.length} B) not stored, so not shown: it could not be decoded as a whole image.]`,
    ]);
  });

  it("a stopped run stores nothing more", async () => {
    const { store, stored } = fakeStore();
    const ac = new AbortController();
    ac.abort();
    await expect(
      storeResultImages({ content: [image(png())] }, "shot", store, undefined, ac.signal),
    ).rejects.toThrow();
    expect(stored).toEqual([]);
  });

  it("storeResultImages and renderResult count the same image blocks, so texts never shift", async () => {
    const { store } = fakeStore();
    class Block {
      type = "image";
      mimeType = "image/png";
      data = png(4, 5).toString("base64");
    }
    const result = { content: [{ type: "image", data: 42 }, new Block(), image(png())] };
    const got = await storeResultImages(result, "shot", store);
    expect(renderResult(result, got?.texts).text).toBe(
      "[unsupported content image]\n" +
        `[Image (image/png, ${png(4, 5).length} B, 4×5), file_id 00000000-0000-4000-8000-000000000001]\n` +
        `[Image (image/png, ${N} B, 2×3), file_id 00000000-0000-4000-8000-000000000002]`,
    );
  });

  it("names an image after the tool's own name", () => {
    expect(resultImageName("plugin__browser__browser_screenshot", 0, "image/jpeg")).toBe(
      "browser_screenshot.jpg",
    );
    expect(resultImageName("connector__abc__take_shot", 2, "image/webp")).toBe("take_shot-3.webp");
    expect(resultImageName("Shot", 0, "image/gif")).toBe("Shot.gif");
  });
});

describe("renderResult without stored images", () => {
  it("an image the pipeline did not store reads as not shown", () => {
    const r = renderResult({ content: [image(png())] });
    expect(r.text).toBe(`[Image (image/png, ${N} B) not stored, so not shown.]`);
    expect(r.contentTypes).toEqual(["image"]);
  });
});

describe("a network ask's kept result", () => {
  it("keeps the stored images, so the result written when the ask settles names them", () => {
    const media = [
      {
        attachmentId: "00000000-0000-4000-8000-000000000001",
        name: "shot.png",
        mediaType: "image/png",
        size: 10,
      },
    ];
    expect(keptExtras({ content: "x", isError: false, media })).toEqual({ media });
    expect(keptExtras({ content: "x", isError: false })).toEqual({});
  });
});
