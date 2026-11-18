/** Design copy of the SDK's `IMAGE_ASPECT_RATIOS` (pinned by tools/checks/test/image-ratios). */
export const INLINE_IMAGE_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;
export type ImageRatio = (typeof INLINE_IMAGE_RATIOS)[number];
export const isImageRatio = (v: unknown): v is ImageRatio =>
  typeof v === "string" && (INLINE_IMAGE_RATIOS as readonly string[]).includes(v);
