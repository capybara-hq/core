import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { UI_PARTS } from "@capybara-hq/plugin-sdk";
import {
  DESIGN_PARTS_TS,
  PLUGIN_CLIENT_PARTS_TS,
  renderDesignUiPartsTs,
  renderPluginClientUiPartsTs,
  renderUiPartsDoc,
  UI_PARTS_DOC,
} from "../ui-parts.js";
import { root } from "./report.js";

// Writes the design and plugin-client copies of the part names and docs/guide/ui-parts.md.
writeFileSync(join(root, DESIGN_PARTS_TS), renderDesignUiPartsTs(UI_PARTS));
writeFileSync(join(root, PLUGIN_CLIENT_PARTS_TS), renderPluginClientUiPartsTs(UI_PARTS));
writeFileSync(join(root, UI_PARTS_DOC), renderUiPartsDoc(UI_PARTS));
console.log(`wrote ${DESIGN_PARTS_TS}, ${PLUGIN_CLIENT_PARTS_TS} and ${UI_PARTS_DOC}`);
