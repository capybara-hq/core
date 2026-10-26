import { checkTokens } from "../tokens.js";
import { report, root } from "./report.js";

report("Design tokens", checkTokens(root));
