import { parseArgs } from "node:util";
import {
  checkAddedComments,
  checkSdkComments,
  diffAgainstBase,
  SDK_SRC_DIR,
} from "../english-comments.js";
import { report, root } from "./report.js";

// `pnpm check:english-comments` scans `packages/plugin-sdk/src` in full; with `--base <sha>` (PRs)
// it also scans the comment lines the diff <base>...HEAD adds anywhere else.
const { values } = parseArgs({ options: { base: { type: "string" } } });
const findings = checkSdkComments(root);
if (values.base !== undefined) {
  const sdkPrefix = `${root}${SDK_SRC_DIR}/`;
  const sdk = new Set(findings.map((f) => `${f.file}:${f.line}`));
  for (const f of checkAddedComments(root, diffAgainstBase(root, values.base))) {
    if (!f.file.startsWith(sdkPrefix) && !sdk.has(`${f.file}:${f.line}`)) findings.push(f);
  }
}
report("English comments", findings);
