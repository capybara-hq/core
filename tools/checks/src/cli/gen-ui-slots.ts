import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { UI_SLOTS } from "@capybara-hq/plugin-sdk";
import { renderUiSlotsDoc, renderUiSlotsTs, UI_SLOTS_DOC, UI_SLOTS_TS } from "../ui-slots.js";
import { root } from "./report.js";

// Writes the web copy of the slot catalog and docs/guide/ui-slots.md from the SDK catalog.
writeFileSync(join(root, UI_SLOTS_TS), renderUiSlotsTs(UI_SLOTS));
writeFileSync(join(root, UI_SLOTS_DOC), renderUiSlotsDoc(UI_SLOTS));
console.log(`wrote ${UI_SLOTS_TS} and ${UI_SLOTS_DOC}`);
