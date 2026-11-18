import { describe, expect, it } from "vitest";
import { type ImageInputCaps, imageInputCaps } from "../../src/models/image-usable.js";
import { generateImageSpec } from "../../src/tools/builtins/image/generate.js";

const props = (c: ImageInputCaps) =>
  // biome-ignore lint/suspicious/noExplicitAny: schema properties are probed by name
  (generateImageSpec(c).inputSchema as { properties: Record<string, any> }).properties;

describe("generateImageSpec", () => {
  it("drops n when the cap is 1", () =>
    expect(props({ maxImages: 1, maxReferenceImages: 2 }).n).toBeUndefined());
  it("caps n at the effective maximum", () =>
    expect(props({ maxImages: 2, maxReferenceImages: 2 }).n.maximum).toBe(2));
  it("drops reference_images when the model takes none", () =>
    expect(props({ maxImages: 2, maxReferenceImages: 0 }).reference_images).toBeUndefined());
  it("caps reference_images at min(4, model)", () => {
    expect(props({ maxImages: 2, maxReferenceImages: 2 }).reference_images.maxItems).toBe(2);
    expect(props({ maxImages: 2, maxReferenceImages: 9 }).reference_images.maxItems).toBe(4);
  });
  it("keeps the other arguments", () =>
    expect(Object.keys(props({ maxImages: 1, maxReferenceImages: 0 }))).toContain("prompt"));
});

describe("imageInputCaps", () => {
  it("takes the config cap when below the model's", () =>
    expect(imageInputCaps({ imageMaxPerCall: 1 }, { maxImages: 4, maxReferenceImages: 0 })).toEqual(
      { maxImages: 1, maxReferenceImages: 0 },
    ));
});
