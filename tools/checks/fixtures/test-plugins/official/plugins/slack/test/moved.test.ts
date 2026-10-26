// A plugin test may import the SDK, @capybara-hq/testing, model-fake (by package name) and its
// own files; everything that reaches into core is reported.
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { startFakeSlack } from "@capybara-hq/testing";
import { createKernel } from "@capybara-hq/kernel"; // MARK kernel-import
import { waitFor } from "../../../packages/core/test/helpers.js"; // MARK relative-import
import { x } from "../src/index.js";

export const OWN = new URL("../src/index.ts", import.meta.url);
export const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
export const METHOD = "tools/call";
export const HELPER = new URL("../../../packages/core/test/fixtures/a.ts", import.meta.url); // MARK relative-path
export const SIBLING = new URL("../../model-fake/src/index.ts", import.meta.url); // MARK sibling-path
export const ROOTED = (root: string) => `${root}/packages/core/src/index.ts`; // MARK rooted-path
export const lazy = () => import("@capybara-hq/plugin-other"); // MARK other-plugin
export { createKernel, defineExtension, startFakeSlack, waitFor, x };
