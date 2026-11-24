import { relative } from "node:path";
import { checkWebApiParity } from "../web-api-parity.js";
import { report, root } from "./report.js";

// `--coverage`: also list the web calls the check could not compare, with the reason.
const r = checkWebApiParity({
  kernel: { tsconfig: `${root}packages/kernel/tsconfig.json`, src: `${root}packages/kernel/src` },
  web: { tsconfig: `${root}apps/web/tsconfig.json`, src: `${root}apps/web/src` },
});
console.log(
  `Web API parity: ${r.compared.length} web call(s) compared with ${new Set(r.compared.map((c) => c.route)).size} kernel route(s), ${r.uncovered.length} not compared`,
);
if (process.argv.includes("--coverage")) {
  for (const u of r.uncovered) console.log(`  ${relative(root, u.file)}:${u.line} ${u.reason}`);
}
report("Web API parity", r.findings);
