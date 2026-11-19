import { apiFetch } from "./api";

/**
 * The platform icon (mobile layout spec §10.2.1; the kernel's
 * `packages/kernel/src/themes/platform-icon*.ts`): `app` the 512 × 512 PNG app icon, `maskable` its
 * 512 × 512 PNG variant with the subject inside the central 80 % safe zone, `favicon` an SVG. Web
 * code never imports kernel code.
 */
export const PLATFORM_ICON_PURPOSES = ["app", "maskable", "favicon"] as const;
export type PlatformIconPurpose = (typeof PLATFORM_ICON_PURPOSES)[number];

/** One uploaded icon as the admin routes return it. */
export interface PlatformIcon {
  purpose: PlatformIconPurpose;
  /** The public URL with the hash: `/api/v1/platform/icon/<purpose>?v=<sha256>`. */
  url: string;
  sha256: string;
  updatedAt: string;
}

/** The type each purpose takes (the kernel refuses any other). */
export const PLATFORM_ICON_TYPE: Record<PlatformIconPurpose, "image/png" | "image/svg+xml"> = {
  app: "image/png",
  maskable: "image/png",
  favicon: "image/svg+xml",
};

/** The largest icon file the kernel takes, in bytes (1 MiB). */
export const PLATFORM_ICON_MAX_BYTES = 1024 * 1024;

/**
 * The web's own Capybara set, used for a purpose with no upload: the PNGs live in `public/`, the
 * SVG is the metadata icon `app/icon.svg`. The sign-in proxy lets exactly these names through.
 */
export const DEFAULT_PLATFORM_ICONS: Record<PlatformIconPurpose, string> = {
  app: "/icon-512.png",
  maskable: "/icon-maskable-512.png",
  favicon: "/icon.svg",
};

/** The product name when the deployment sets no `platform.name`. */
export const DEFAULT_PLATFORM_NAME = "Capybara";

/** `GET /api/v1/admin/platform/icons` (super admin): the uploaded icons. */
export const listPlatformIcons = () =>
  apiFetch<{ icons: PlatformIcon[] }>("/api/v1/admin/platform/icons");

/** `PUT /api/v1/admin/platform/icons/:purpose`: the file as standard base64. */
export const setPlatformIcon = (purpose: PlatformIconPurpose, dataBase64: string) =>
  apiFetch<PlatformIcon>(`/api/v1/admin/platform/icons/${purpose}`, {
    method: "PUT",
    body: JSON.stringify({ contentType: PLATFORM_ICON_TYPE[purpose], dataBase64 }),
  });

/** `DELETE /api/v1/admin/platform/icons/:purpose`: back to the web's default. */
export const clearPlatformIcon = (purpose: PlatformIconPurpose) =>
  apiFetch<void>(`/api/v1/admin/platform/icons/${purpose}`, { method: "DELETE" });

/** A file's bytes as standard base64, read with `FileReader` (no data-URL prefix). */
export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
