import { checkPluginPermissions } from "../plugin-permissions.js";
import { extensionDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Extension permissions", checkPluginPermissions(extensionDirs()));
