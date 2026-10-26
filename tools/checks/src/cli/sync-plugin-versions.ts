import { syncPluginVersions } from "@capybara-hq/plugin-tools";
import { root } from "./report.js";

// Run by `pnpm version-packages` (the Version Packages PR) right after `changeset version`.
const changed = syncPluginVersions(root);
console.log(
  changed.length === 0
    ? "plugin versions already match package.json"
    : `plugin versions synced from package.json: ${changed.join(", ")}`,
);
