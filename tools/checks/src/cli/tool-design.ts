import { checkToolDesign } from "../tool-design.js";
import { pluginDirs, requireScanTargets, toolDesignDirs } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Tool design", checkToolDesign(toolDesignDirs(pluginDirs())));
