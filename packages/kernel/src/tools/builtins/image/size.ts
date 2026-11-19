import type {
  ImageAspectRatio,
  ImageSize,
  ModelImageGenerationInfo,
} from "@capybara-hq/plugin-sdk";

/** Log-ratio differences closer than this are the same shape. */
const SHAPE_EPSILON = 1e-9;

const area = (s: ImageSize): number => s.width * s.height;

/**
 * The output size `GenerateImage` asks for (vision-read spec §3.3). The shape is `aspectRatio`,
 * or the ratio of the model's default size; the candidates are the sizes of the closest shape.
 * `standard` takes the candidate whose area is closest to `standardPixels` (a tie: the smaller
 * one); `high` takes the largest candidate. A model with one size gives that size.
 */
export function pickStandardSize(
  info: ModelImageGenerationInfo,
  q: {
    aspectRatio?: ImageAspectRatio | undefined;
    resolution: "standard" | "high";
    standardPixels: number;
  },
): ImageSize {
  let target: number;
  if (q.aspectRatio !== undefined) {
    const [rw, rh] = q.aspectRatio.split(":").map(Number) as [number, number];
    target = Math.log(rw / rh);
  } else {
    target = Math.log(info.defaultSize.width / info.defaultSize.height);
  }
  const diff = (s: ImageSize): number => Math.abs(Math.log(s.width / s.height) - target);
  const best = Math.min(...info.sizes.map(diff));
  const candidates = info.sizes.filter((s) => diff(s) - best <= SHAPE_EPSILON);
  let pick = candidates[0] ?? info.defaultSize;
  for (const s of candidates) {
    if (q.resolution === "high") {
      if (area(s) > area(pick)) pick = s;
    } else {
      const d = Math.abs(area(s) - q.standardPixels);
      const pd = Math.abs(area(pick) - q.standardPixels);
      if (d < pd || (d === pd && area(s) < area(pick))) pick = s;
    }
  }
  return pick;
}
