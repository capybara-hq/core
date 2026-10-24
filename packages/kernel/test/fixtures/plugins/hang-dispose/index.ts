import { defineExtension } from "@capybara-hq/plugin-sdk";

/** dispose() 永不返回：内核按 disposeTimeout 记日志后继续，不卡住后续的 unload / reload。 */
export default defineExtension({
  name: "hang-dispose",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  setup() {},
  dispose() {
    return new Promise<void>(() => {});
  },
});
