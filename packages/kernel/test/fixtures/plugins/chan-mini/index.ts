import { defineExtension, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import {
  FakeImConnection,
  makeFakeImChannel,
} from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/** fake-im's connection schema with a config UI hint on `appId` (the kernel passes it through). */
const ChanMiniConnection = FakeImConnection.extend({
  appId: ui(z.string().min(1), { label: { zh: "应用 ID", en: "App ID" } }),
});

/**
 * 只提供 `channel@1` 的测试渠道：与 fake-im 同一个实现（连 `@capybara-hq/testing` 的 startFakeChannelServer），
 * 只是插件名不同（身份源键为 `chan-mini:<租户>`），也不需要部署配置。
 */
export default defineExtension({
  name: "chan-mini",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", {
      ...makeFakeImChannel({ cards: true, edit: true, threads: true }),
      connectionSchema: ChanMiniConnection,
    });
  },
});
