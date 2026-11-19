import { IMAGE_ASPECT_RATIOS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { INLINE_IMAGE_RATIOS } from "../../../packages/design/src/conversation/image-ratios.js";

describe("inline image ratios", () => {
  it("ratios match the SDK", () => {
    expect([...INLINE_IMAGE_RATIOS]).toEqual([...IMAGE_ASPECT_RATIOS]);
  });
});
