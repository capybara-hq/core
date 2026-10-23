import { join } from "node:path";
import { checkI18n } from "../i18n.js";
import { report, root } from "./report.js";

report("UI copy", checkI18n(join(root, "apps/web/messages")));
