import { join } from "node:path";
import { checkDeps } from "../deps.js";
import { pluginDirs } from "./dirs.js";
import { report, root } from "./report.js";

report("依赖边界", checkDeps(pluginDirs(), [join(root, "packages/plugin-sdk")]));
