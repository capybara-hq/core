import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  checkPluginClientApiReport,
  PLUGIN_CLIENT_API_TS,
  renderPluginClientApiTs,
} from "../plugin-client-api.js";
import { root } from "./report.js";

// Writes the web copy of the package's export list and the package's API report.
const out = join(root, PLUGIN_CLIENT_API_TS);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderPluginClientApiTs());
await checkPluginClientApiReport({ update: true });
console.log(`wrote ${PLUGIN_CLIENT_API_TS} and packages/plugin-client/api/plugin-client.api.md`);
