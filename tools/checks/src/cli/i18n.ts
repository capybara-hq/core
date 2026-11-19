import { join } from "node:path";
import { checkDesignI18n, checkI18n, checkSourceZh, checkWebI18nKeys } from "../i18n.js";
import { report, root } from "./report.js";

report("UI copy", [
  ...checkI18n(join(root, "apps/web/messages")),
  ...checkWebI18nKeys(join(root, "apps/web/src"), join(root, "apps/web/messages")),
  ...checkDesignI18n(join(root, "packages/design/src/i18n.ts")),
  ...checkSourceZh([join(root, "packages/kernel/src"), join(root, "packages/plugin-sdk/src")]),
]);
