import { join } from "node:path";
import { checkWebUi } from "../web-ui.js";
import { report, root } from "./report.js";

report("界面规范", checkWebUi(join(root, "apps/web/src"), join(root, "packages/design/src")));
