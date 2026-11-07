import { generateAgentDocs, scaffoldPointTopics } from "../agent-docs.js";
import { root } from "./report.js";

for (const f of scaffoldPointTopics(root)) console.log(`Created ${f}`);
for (const f of generateAgentDocs(root)) console.log(`Wrote ${f}`);
