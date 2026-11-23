import { checkOrgFilter } from "../org-filter.js";
import { report, root } from "./report.js";

report("Org filter", checkOrgFilter(root));
