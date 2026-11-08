import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  parseTokens,
  renderThemeTokensTs,
  renderTokensCss,
  renderTokensTs,
  THEME_TOKENS_TS,
  TOKENS_CSS,
  TOKENS_JSON,
  TOKENS_TS,
} from "../tokens.js";
import { root } from "./report.js";

// Writes packages/design/src/styles/tokens.css, src/tokens.ts and the SDK theme-tokens file from docs/design/tokens.json.
const file = join(root, TOKENS_JSON);
const { tokens, findings } = parseTokens(readFileSync(file, "utf8"), file);
if (!tokens) {
  for (const f of findings)
    console.error(`${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
  process.exit(1);
}
writeFileSync(join(root, TOKENS_CSS), renderTokensCss(tokens));
writeFileSync(join(root, TOKENS_TS), renderTokensTs(tokens));
writeFileSync(join(root, THEME_TOKENS_TS), renderThemeTokensTs(tokens));
console.log(`wrote ${TOKENS_CSS}, ${TOKENS_TS} and ${THEME_TOKENS_TS}`);
