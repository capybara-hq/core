import { checkTestPlugins } from "../test-plugins.js";
import { report, root } from "./report.js";

report("Test plugins", checkTestPlugins(root));
