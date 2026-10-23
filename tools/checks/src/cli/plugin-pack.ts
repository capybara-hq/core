import { checkPluginPack } from "../plugin-pack.js";
import { pluginDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Plugin pack", await checkPluginPack(pluginDirs()));
