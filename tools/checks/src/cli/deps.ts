import { join } from "node:path";
import { checkDeps } from "../deps.js";
import { pluginDirs, requireScanTargets } from "./dirs.js";
import { report, root } from "./report.js";

requireScanTargets();

report("Dependency boundary", checkDeps(pluginDirs(), [join(root, "packages/plugin-sdk")]));
