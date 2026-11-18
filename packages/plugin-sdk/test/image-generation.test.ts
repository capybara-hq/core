import { describe, expect, test } from "vitest";
import {
  isRetryableKind,
  isValidImageGenerationInfo,
  ModelError,
  type ModelImageGenerationInfo,
  pickImageSize,
  validateImageGenerateResult,
  validatePermissions,
} from "../src/index.js";

const info: ModelImageGenerationInfo = {
  sizes: [
    { width: 1024, height: 1024 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 },
    { width: 2048, height: 2048 },
  ],
  defaultSize: { width: 1024, height: 1024 },
  maxImages: 4,
  maxReferenceImages: 2,
  outputMediaTypes: ["image/png"],
};

describe("image generation contract", () => {
  test("pickImageSize: no size or ratio gives the default", () =>
    expect(pickImageSize(info, {})).toEqual({ ok: true, size: { width: 1024, height: 1024 } }));

  test("pickImageSize: ratio picks the closest ratio, ties by area closest to the default", () => {
    expect(pickImageSize(info, { aspectRatio: "3:2" })).toEqual({
      ok: true,
      size: { width: 1536, height: 1024 },
    });
    expect(pickImageSize(info, { aspectRatio: "1:1" })).toEqual({
      ok: true,
      size: { width: 1024, height: 1024 },
    });
    expect(pickImageSize(info, { aspectRatio: "16:9" })).toEqual({
      ok: true,
      size: { width: 1536, height: 1024 },
    });
  });

  test("pickImageSize: the area rule breaks a ratio tie, not declaration order", () => {
    const big: ModelImageGenerationInfo = {
      ...info,
      sizes: [
        { width: 2048, height: 2048 },
        { width: 1024, height: 1024 },
      ],
    };
    expect(pickImageSize(big, { aspectRatio: "1:1" })).toEqual({
      ok: true,
      size: { width: 1024, height: 1024 },
    });
  });

  test("pickImageSize: an exact declared size is returned", () =>
    expect(pickImageSize(info, { size: { width: 2048, height: 2048 } })).toEqual({
      ok: true,
      size: { width: 2048, height: 2048 },
    }));

  test("pickImageSize: an undeclared exact size names the declared ones", () => {
    const r = pickImageSize(info, { size: { width: 999, height: 999 } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("1024x1024, 1536x1024, 1024x1536, 2048x2048");
  });

  test("validateImageGenerateResult", () => {
    const req = { model: "m", prompt: "p", size: info.defaultSize, n: 2, params: {} };
    const png = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputImages: 2,
    };
    expect(validateImageGenerateResult(req, info, { images: [png, png], usage })).toBeNull();
    expect(validateImageGenerateResult(req, info, { images: [png], usage })).toMatch(/2 images/);
    expect(
      validateImageGenerateResult(req, info, {
        images: [png, { mediaType: "image/jpeg", data: "x" }],
        usage,
      }),
    ).toMatch(/image\/jpeg/);
    expect(
      validateImageGenerateResult(req, info, {
        images: [png, { mediaType: "image/png", data: "not base64!" }],
        usage,
      }),
    ).toMatch(/base64/);
    expect(validateImageGenerateResult(req, info, "nope")).not.toBeNull();
  });

  test("isValidImageGenerationInfo", () => {
    expect(isValidImageGenerationInfo(info)).toBe(true);
    expect(isValidImageGenerationInfo({ ...info, defaultSize: { width: 1, height: 1 } })).toBe(
      false,
    );
    expect(isValidImageGenerationInfo({ ...info, maxImages: 0 })).toBe(false);
    expect(isValidImageGenerationInfo({ ...info, outputMediaTypes: ["image/bmp"] })).toBe(false);
    expect(isValidImageGenerationInfo({ ...info, outputMediaTypes: [] })).toBe(false);
    expect(isValidImageGenerationInfo(null)).toBe(false);
  });

  test("refusal is a model error kind and not retryable", () => {
    expect(isRetryableKind("refusal")).toBe(false);
    expect(new ModelError("refusal", "x").kind).toBe("refusal");
  });

  test("permissions.models rejects an unknown kind", () =>
    expect(
      validatePermissions("p", {
        models: [{ purpose: "p.x", kind: "rerank", label: { zh: "图", en: "Img" } }],
      }).join(),
    ).toMatch(/kind/));

  test("permissions.models accepts image_generation", () =>
    expect(
      validatePermissions("p", {
        models: [{ purpose: "p.img", kind: "image_generation", label: { zh: "图", en: "Img" } }],
      }),
    ).toEqual([]));
});
