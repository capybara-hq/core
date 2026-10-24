import { writeFileSync } from "node:fs";
import { KernelConfigSchema, renderConfigDocs } from "@capybara-hq/kernel";
import { DEFAULT_DOC_PATH } from "../config-docs.js";

writeFileSync(DEFAULT_DOC_PATH, renderConfigDocs(KernelConfigSchema));
console.log(`Wrote ${DEFAULT_DOC_PATH}`);
