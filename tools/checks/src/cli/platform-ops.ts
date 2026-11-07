import { checkPlatformOps } from "../platform-ops.js";
import { report, root } from "./report.js";

report("Platform operations", checkPlatformOps(root));
