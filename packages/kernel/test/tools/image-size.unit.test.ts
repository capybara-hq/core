import type { ModelImageGenerationInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { pickStandardSize } from "../../src/tools/builtins/image/size.js";

const K1 = [
  [1024, 1024],
  [1152, 864],
  [864, 1152],
  [1248, 832],
  [832, 1248],
  [1280, 720],
  [720, 1280],
] as const;
const K2 = [
  [2048, 2048],
  [2304, 1728],
  [1728, 2304],
  [2496, 1664],
  [1664, 2496],
  [2560, 1440],
  [1440, 2560],
] as const;
const sizes = (list: readonly (readonly [number, number])[]) =>
  list.map(([width, height]) => ({ width, height }));
const info = (
  list: readonly (readonly [number, number])[],
  def: readonly [number, number],
): ModelImageGenerationInfo => ({
  sizes: sizes(list),
  defaultSize: { width: def[0], height: def[1] },
  maxImages: 4,
  maxReferenceImages: 2,
  outputMediaTypes: ["image/png"],
});
const PIXELS = 1_048_576;
const fmt = (s: { width: number; height: number }) => `${s.width}x${s.height}`;

describe("pickStandardSize", () => {
  const ark = info([...K1, ...K2], [2048, 2048]);
  it("standard picks the size closest to the target area for the shape", () =>
    expect(
      fmt(
        pickStandardSize(ark, {
          aspectRatio: "3:4",
          resolution: "standard",
          standardPixels: PIXELS,
        }),
      ),
    ).toBe("864x1152"));
  it("high picks the largest size for the shape", () =>
    expect(
      fmt(
        pickStandardSize(ark, { aspectRatio: "3:4", resolution: "high", standardPixels: PIXELS }),
      ),
    ).toBe("1728x2304"));
  it("no aspect ratio uses the shape of the default size", () => {
    expect(fmt(pickStandardSize(ark, { resolution: "standard", standardPixels: PIXELS }))).toBe(
      "1024x1024",
    );
    expect(fmt(pickStandardSize(ark, { resolution: "high", standardPixels: PIXELS }))).toBe(
      "2048x2048",
    );
  });
  it("a model with 2K sizes only gives its smallest size for the shape", () =>
    expect(
      fmt(
        pickStandardSize(info(K2, [2048, 2048]), {
          aspectRatio: "3:4",
          resolution: "standard",
          standardPixels: PIXELS,
        }),
      ),
    ).toBe("1728x2304"));
  it("an equal distance picks the smaller area", () => {
    const tie = info(
      [
        [1000, 1000],
        [1200, 1200],
      ],
      [1000, 1000],
    );
    // 1,220,000 is exactly between 1,000,000 and 1,440,000
    expect(fmt(pickStandardSize(tie, { resolution: "standard", standardPixels: 1_220_000 }))).toBe(
      "1000x1000",
    );
  });
  it("a single-size model gives that size", () =>
    expect(
      fmt(
        pickStandardSize(info([[512, 768]], [512, 768]), {
          aspectRatio: "16:9",
          resolution: "high",
          standardPixels: PIXELS,
        }),
      ),
    ).toBe("512x768"));
});
