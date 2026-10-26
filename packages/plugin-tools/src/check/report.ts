import { relative } from "node:path";
import type { Finding } from "./source.js";

/** One finding as a line: `<file relative to root>:<line> <rule> <message>`. */
export const formatFinding = (f: Finding, root: string) =>
  `${relative(root, f.file) || f.file}:${f.line} ${f.rule} ${f.message}`;

/**
 * Prints the result of one check: `[name] passed`, or the finding count and one line per finding
 * (stderr). Returns whether it passed.
 */
export function printCheck(name: string, findings: Finding[], root: string): boolean {
  if (findings.length === 0) {
    console.log(`[${name}] passed`);
    return true;
  }
  console.error(`[${name}] ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${formatFinding(f, root)}`);
  return false;
}
