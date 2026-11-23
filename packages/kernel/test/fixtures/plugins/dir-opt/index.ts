import { defineExtension } from "@capybara-hq/plugin-sdk";
import {
  FakeImDirectoryConfig,
  makeFakeImDirectory,
} from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/**
 * Ruling A28 test extension: `directory@1` implements the optional `configured`; while the
 * org-overridable deployment field `directoryUrl` is unset in the effective config, the kernel
 * skips silently (no scan, no job, no audit) and a manual sync is 409 `directory.not_configured`.
 * Identity source key `dir-opt:<tenant>`.
 */
export default defineExtension({
  name: "dir-opt",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["directory@1"],
  config: { deployment: FakeImDirectoryConfig },
  setup(ctx) {
    ctx.provide("directory@1", makeFakeImDirectory(ctx));
  },
});
