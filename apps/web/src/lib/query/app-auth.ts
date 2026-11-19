import { getPlatformMeta } from "../app-auth";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The platform's public description; the consent page names the platform from it. */
export const platformMetaQuery = () =>
  defineQuery({
    key: keys.deployment().platformMeta(),
    fn: getPlatformMeta,
    freshness: "deployment",
  });
