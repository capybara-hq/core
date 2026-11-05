import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import {
  FakeImConnection,
  makeFakeImChannel,
} from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/**
 * A hand-made channel whose connection schema hints make the form conversion throw (a BigInt in
 * the `ui` meta cannot be copied as JSON): the schema endpoint and a refused save must still answer.
 */
export default defineExtension({
  name: "chan-throwhints",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", {
      ...makeFakeImChannel({ cards: true, edit: true, threads: true }),
      connectionSchema: FakeImConnection.extend({
        appId: z
          .string()
          .min(1)
          .meta({ ui: { label: { zh: "应用 ID", en: "App ID" }, big: 1n } }),
      }),
    });
  },
});
