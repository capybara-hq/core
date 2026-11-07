import { checkAgentDocs } from "../agent-docs.js";
import { report, root } from "./report.js";

report("Agent docs", checkAgentDocs(root));
