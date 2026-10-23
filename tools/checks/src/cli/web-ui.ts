import { join } from "node:path";
import { checkWebUi } from "../web-ui.js";
import { report, root } from "./report.js";

report("Web UI rules", checkWebUi(join(root, "apps/web/src"), join(root, "packages/design/src")));
