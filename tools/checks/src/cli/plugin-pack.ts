import { checkPluginPack } from "../plugin-pack.js";
import { pluginDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("插件打包", await checkPluginPack(pluginDirs()));
