import { checkPluginClientApi, checkPluginClientApiReport } from "../plugin-client-api.js";
import { report, root } from "./report.js";

report("plugin-client API", [
  ...checkPluginClientApi(root),
  ...(await checkPluginClientApiReport({ update: false })),
]);
