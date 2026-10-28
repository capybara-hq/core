import { checkPluginReleaseMetadata } from "@capybara-hq/plugin-tools";
import { checkReleaseMetadata } from "../release-metadata.js";
import { pluginDirs } from "./dirs.js";
import { report, root } from "./report.js";

// The libraries and apps, plus plugin-tools' `plugin-release-metadata` on core's plugins.
report("release metadata", [
  ...checkReleaseMetadata(root),
  ...checkPluginReleaseMetadata(pluginDirs(), root),
]);
