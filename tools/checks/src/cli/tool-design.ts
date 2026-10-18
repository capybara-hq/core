import { checkToolDesign } from "../tool-design.js";
import { pluginDirs, requireScanTargets, toolDesignDirs } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("工具设计", checkToolDesign(toolDesignDirs(pluginDirs())));
