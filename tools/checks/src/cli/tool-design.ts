import { checkToolDesign } from "../tool-design.js";
import { extensionDirs, requireScanTargets, toolDesignDirs } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Tool design", checkToolDesign(toolDesignDirs(extensionDirs())));
