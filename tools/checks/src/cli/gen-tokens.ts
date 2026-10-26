import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  parseTokens,
  renderTokensCss,
  renderTokensTs,
  TOKENS_CSS,
  TOKENS_JSON,
  TOKENS_TS,
} from "../tokens.js";
import { root } from "./report.js";

// Writes packages/design/src/styles/tokens.css and src/tokens.ts from docs/design/tokens.json.
const file = join(root, TOKENS_JSON);
const { tokens, findings } = parseTokens(readFileSync(file, "utf8"), file);
if (!tokens) {
  for (const f of findings)
    console.error(`${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
  process.exit(1);
}
writeFileSync(join(root, TOKENS_CSS), renderTokensCss(tokens));
writeFileSync(join(root, TOKENS_TS), renderTokensTs(tokens));
console.log(`wrote ${TOKENS_CSS} and ${TOKENS_TS}`);
