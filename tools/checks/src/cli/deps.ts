import { join } from "node:path";
import { checkDeps } from "../deps.js";
import { extensionDirs, requireScanTargets } from "./dirs.js";
import { report, root } from "./report.js";

requireScanTargets();

report("Dependency boundary", checkDeps(extensionDirs(), [join(root, "packages/plugin-sdk")]));
