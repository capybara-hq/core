import { checkPluginPermissions } from "../plugin-permissions.js";
import { pluginDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Plugin permissions", checkPluginPermissions(pluginDirs()));
