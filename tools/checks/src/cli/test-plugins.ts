import { checkPluginTestImports } from "@capybara-hq/plugin-tools";
import { checkTestPlugins } from "../test-plugins.js";
import { pluginDirs } from "./dirs.js";
import { report, root } from "./report.js";

// The core rules, plus plugin-tools' `plugin-test-imports` on core's plugins (the other half of the
// boundary; `capybara-plugin check` runs it in a plugin repository).
report("Test plugins", [...checkTestPlugins(root), ...checkPluginTestImports(pluginDirs())]);
