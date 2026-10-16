import { checkPluginState } from "../plugin-state.js";
import { pluginDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("插件状态", checkPluginState(pluginDirs()));
