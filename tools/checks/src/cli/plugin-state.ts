import { checkPluginState } from "../plugin-state.js";
import { pluginDirs } from "./dirs.js";
import { report } from "./report.js";

report("插件状态", checkPluginState(pluginDirs()));
