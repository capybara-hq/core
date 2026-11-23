import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { fakeImDirectory } from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/**
 * A test extension that only provides `directory@1`: the fake-im implementation under another name
 * (identity source key `dir-mini:<tenant>`). Its deployment field `directoryUrl` (a book of
 * startFakeChannelServer()) is required and org-overridable: the platform leaves it empty, so an
 * org needs its own copy before it syncs (`needs_config` until then).
 */
export default defineExtension({
  name: "dir-mini",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["directory@1"],
  config: { deployment: z.object({ directoryUrl: z.string().url() }) },
  setup(ctx) {
    ctx.provide("directory@1", fakeImDirectory);
  },
});
