import { defineExtension } from "@capybara-hq/plugin-sdk";
import {
  FakeImOrgConfig,
  fakeImDirectory,
} from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/**
 * 只提供 `directory@1` 的测试插件：与 fake-im 同一个实现（组织级配置 `{ url }` 指向
 * startFakeChannelServer().book(key).url），只是插件名不同（身份源键为 `dir-mini:<租户>`）。
 */
export default defineExtension({
  name: "dir-mini",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["directory@1"],
  config: { org: FakeImOrgConfig },
  setup(ctx) {
    ctx.provide("directory@1", fakeImDirectory);
  },
});
