import { checkTestPlugins } from "../test-plugins.js";
import { report, root } from "./report.js";

report("测试插件", checkTestPlugins(root));
