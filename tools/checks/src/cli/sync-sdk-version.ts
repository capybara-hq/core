import { SDK_SOURCE, syncSdkVersion } from "../sdk-version.js";
import { root } from "./report.js";

// Run by `pnpm version-packages` (the Version Packages PR) after `changeset version`; the root
// script then regenerates the SDK API report, which records SDK_VERSION.
const r = syncSdkVersion(root);
console.log(
  r.changed
    ? `SDK_VERSION set to ${r.version} in ${SDK_SOURCE}`
    : `SDK_VERSION already ${r.version}`,
);
