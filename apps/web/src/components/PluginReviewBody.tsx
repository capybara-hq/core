"use client";

import { useLocale } from "next-intl";
import type { PermissionsMismatch, PluginReview } from "../lib/catalog";
import { fromReview } from "./plugin-contents/from-review";
import { PluginContents } from "./plugin-contents/PluginContents";

/**
 * A plugin package's review, shared by the super admin's import (`/admin/plugins/import`) and an
 * org admin's upload (`OrgPluginUploadDialog`): the package's contents ({@link PluginContents})
 * at the install stage, or the update stage when the platform already has another version.
 */
export function PluginReviewBody({
  review,
  mismatch = null,
  audience = "platform",
  installedVersion = null,
}: {
  review: PluginReview;
  /**
   * The version the platform has installed when this import updates it: the chip then reads
   * from → to whether or not the package has an extension.
   */
  installedVersion?: string | null;
  /** A marketplace import's permission summary that differs from the package. */
  mismatch?: PermissionsMismatch;
  /** `org`: an org admin's view: the publisher only, no source, build, license or translation. */
  audience?: "platform" | "org";
}) {
  const locale = useLocale();
  const model = fromReview(review, { installedVersion, locale });
  return (
    <PluginContents
      model={model}
      audience={audience}
      stage={model.head.fromVersion != null ? "update" : "install"}
      mismatch={mismatch}
    />
  );
}
