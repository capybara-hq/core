import { describe, expect, it } from "vitest";
import { renderResult } from "../../src/tools/outputs.js";
import {
  RESULT_IMAGES_MAX,
  resultImageName,
  type StoreResultImage,
  storeResultImages,
} from "../../src/tools/result-images.js";

/** A 2×3 PNG header (signature + IHDR), enough for the sniffer and its size. */
function png(width = 2, height = 3, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

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
      { name: "browser_screenshot.png", contentType: "image/png", size: 33 },
      // the sniffed type wins over the declared one
      { name: "browser_screenshot-2.png", contentType: "image/png", size: 33 },
    ]);
    expect(got?.media).toEqual([
      {
        attachmentId: "00000000-0000-4000-8000-000000000001",
        name: "browser_screenshot.png",
        mediaType: "image/png",
        size: 33,
      },
      {
        attachmentId: "00000000-0000-4000-8000-000000000002",
        name: "browser_screenshot-2.png",
        mediaType: "image/png",
        size: 33,
      },
    ]);
    expect(renderResult(result, got?.texts).text).toBe(
      "Screenshot 2x3.\n" +
        "[Image (image/png, 33 B, 2×3), file_id 00000000-0000-4000-8000-000000000001]\n" +
        "[Image (image/png, 33 B, 4×5), file_id 00000000-0000-4000-8000-000000000002]",
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
      "[Image (image/png, 33 B) not stored, so not shown: this conversation reached its limit for stored images.]",
      "[Image (image/svg+xml, 15 B) not stored, so not shown: only PNG, JPEG, GIF and WebP images are stored.]",
      "[Image (image/png, 5.0 MB) not stored, so not shown: it is over the 5 MB image limit.]",
    ]);
  });

  it("no object store, or a failed store: not stored, said so", async () => {
    const result = { content: [image(png())] };
    const none = await storeResultImages(result, "shot", undefined);
    expect(none?.texts).toEqual([
      "[Image (image/png, 33 B) not stored, so not shown: file storage is not configured in this deployment.]",
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
      "[Image (image/png, 33 B) not stored, so not shown: storing it failed.]",
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
      `[Image (image/png, 33 B) not stored, so not shown: a tool result stores at most ${RESULT_IMAGES_MAX} images.]`,
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
    expect(r.text).toBe("[Image (image/png, 33 B) not stored, so not shown.]");
    expect(r.contentTypes).toEqual(["image"]);
  });
});
