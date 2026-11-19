import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/**
 * The platform icon (mobile layout spec §10.2.1): `app` the 512 × 512 PNG app icon, `maskable`
 * its 512 × 512 PNG variant with the subject inside the central 80 % safe zone, `favicon` an SVG.
 */
export const PLATFORM_ICON_PURPOSES = ["app", "maskable", "favicon"] as const;
export type PlatformIconPurpose = (typeof PLATFORM_ICON_PURPOSES)[number];

/** The largest icon file in bytes (1 MiB), whatever its purpose. */
export const PLATFORM_ICON_MAX_BYTES = 1024 * 1024;

/** The one size of a PNG icon (`app`, `maskable`), in pixels. */
export const PLATFORM_ICON_PNG_SIZE = 512;

/**
 * The longest `dataBase64` the route reads: the base64 of 1.5 MiB, so a file somewhat over
 * {@link PLATFORM_ICON_MAX_BYTES} still reaches the size check and is refused with
 * `platform_icon.too_large` (the route's body limit, `PLATFORM_ICON_BODY_LIMIT`, admits it).
 */
export const PLATFORM_ICON_MAX_BASE64 = 4 * Math.ceil((1.5 * PLATFORM_ICON_MAX_BYTES) / 3);

/** `:purpose` of the icon routes. */
export const PlatformIconParams = z.object({
  purpose: z
    .enum(PLATFORM_ICON_PURPOSES)
    .describe(
      "Which icon: app (the 512 × 512 PNG app icon), maskable (its 512 × 512 PNG variant whose subject stays inside the central 80 % safe zone) or favicon (an SVG).",
    ),
});

/** `PUT /api/v1/admin/platform/icons/:purpose`: the file as standard base64. */
export const PlatformIconBody = z
  .object({
    contentType: z
      .enum(["image/png", "image/svg+xml"])
      .describe("image/png for app and maskable, image/svg+xml for favicon."),
    dataBase64: z
      .string()
      .min(1)
      .max(PLATFORM_ICON_MAX_BASE64)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        "dataBase64 must be standard base64 (A-Z, a-z, 0-9, +, / with = padding)",
      )
      .describe(
        "The file's bytes as standard base64, at most 1 MiB decoded (an SVG favicon at most 128 KiB).",
      ),
  })
  .strict();

/** `GET /api/v1/platform/icon/:purpose`: `v` is the SHA-256 the URL was built with. */
export const PlatformIconQuery = z.object({
  v: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "v must be a SHA-256 in lower-case hex")
    .optional(),
});

/** One uploaded icon as the admin routes return it. */
export interface PlatformIconView {
  purpose: PlatformIconPurpose;
  /** The public URL, carrying the hash: `/api/v1/platform/icon/<purpose>?v=<sha256>`. */
  url: string;
  sha256: string;
  updatedAt: string;
}

/** The admin icon routes the Platform operations mirror (`check:platform-ops` keys). */
export const PLATFORM_ICON_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/platform/icons" },
  {
    route: "PUT /api/v1/admin/platform/icons/:purpose",
    params: PlatformIconParams,
    body: PlatformIconBody,
  },
  { route: "DELETE /api/v1/admin/platform/icons/:purpose", params: PlatformIconParams },
];
