import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { errorsOf, type Finding } from "../source.js";

/** Repository root. */
export const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** Prints the findings and exits with 1 if there is any that is not a warning. */
export function report(name: string, findings: Finding[]): void {
  for (const f of findings) {
    console.error(`${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
  }
  const errors = errorsOf(findings).length;
  if (errors > 0) {
    console.error(`\n${name} check failed: ${errors} finding(s)`);
    process.exit(1);
  }
  const warnings = findings.length - errors;
  console.log(`${name} check passed${warnings > 0 ? ` with ${warnings} warning(s)` : ""}`);
}
