import { defineExtension, OBJECT_STORE_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { MemoryObjectStore } from "../../../storage/memory-store.js";

/** 存储测试：提供 object-store@1 的内存实现（每次 setup 一个新的存储）。 */
export default defineExtension({
  name: "mem-store",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [OBJECT_STORE_EXTENSION_POINT],
  setup(ctx) {
    ctx.provide(OBJECT_STORE_EXTENSION_POINT, new MemoryObjectStore());
  },
});
