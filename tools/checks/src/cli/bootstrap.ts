import { join } from "node:path";
import { checkBootstrap } from "../bootstrap.js";
import { report, root } from "./report.js";

// `--write` updates stale versions and integrities in bootstrap.json instead of reporting them.
const write = process.argv.includes("--write");

report(
  "Bootstrap manifest",
  await checkBootstrap(join(root, "packages/kernel/bootstrap.json"), root, { write }),
);
