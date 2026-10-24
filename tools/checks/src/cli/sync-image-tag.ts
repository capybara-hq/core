import { imageVersion, syncImageTag } from "../image-tag.js";
import { root } from "./report.js";

// Run by `pnpm version-packages` (the Version Packages PR) right after `changeset version`.
const changed = syncImageTag(root);
console.log(
  changed.length === 0
    ? `image tag defaults already at ${imageVersion(root)}`
    : `image tag defaults set to ${imageVersion(root)}: ${changed.join(", ")}`,
);
