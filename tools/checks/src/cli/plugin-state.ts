import { checkPluginState } from "../plugin-state.js";
import { extensionDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Extension state", checkPluginState(extensionDirs()));
