import { relative } from "node:path";
import { errorsOf, type Finding } from "./source.js";

/** One finding as a line: `<file relative to root>:<line> <rule> <message>`. */
export const formatFinding = (f: Finding, root: string) =>
  `${relative(root, f.file) || f.file}:${f.line} ${f.rule} ${f.message}`;

/**
 * Prints the result of one check: `[name] passed` (`passed with N warning(s)` and one line per
 * warning when it has only warnings), or the finding count and one line per finding (stderr).
 * Returns whether it passed (warnings do not fail it).
 */
export function printCheck(name: string, findings: Finding[], root: string): boolean {
  const errors = errorsOf(findings);
  if (findings.length === 0) {
    console.log(`[${name}] passed`);
    return true;
  }
  if (errors.length === 0) {
    console.error(`[${name}] passed with ${findings.length} warning(s)`);
    for (const f of findings) console.error(`  ${formatFinding(f, root)}`);
    return true;
  }
  const warnings = findings.length - errors.length;
  console.error(
    `[${name}] ${errors.length} finding(s)${warnings > 0 ? ` and ${warnings} warning(s)` : ""}`,
  );
  for (const f of findings) console.error(`  ${formatFinding(f, root)}`);
  return false;
}
