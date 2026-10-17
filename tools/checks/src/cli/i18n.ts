import { join } from "node:path";
import { checkI18n } from "../i18n.js";
import { report, root } from "./report.js";

report("界面文案", checkI18n(join(root, "apps/web/messages")));
