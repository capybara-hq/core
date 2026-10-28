// A plugin test may import the SDK, @capybara-hq/testing, model-fake (by package name) and its
// own files; everything that reaches into core is reported (lines marked FLAG).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel } from "@capybara-hq/kernel"; // FLAG kernel-import
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { x as own } from "@capybara-hq/plugin-slack";
import { startFakeSlack } from "@capybara-hq/testing";
import { waitFor } from "../../../../packages/core/test/helpers.js"; // FLAG relative-import
import { x } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const OWN = new URL("../../src/index.ts", import.meta.url);
export const PLUGIN_ROOT = join(here, "..", "..");
export const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
export const DATA = { petId: ".." };
export const METHOD = "tools/call";
export const HELPER = new URL("../../../../packages/core/test/a.ts", import.meta.url); // FLAG relative-path
export const SIBLING = new URL("../../../model-fake/src/index.ts", import.meta.url); // FLAG sibling-path
export const ROOTED = (root: string) => `${root}/packages/core/src/index.ts`; // FLAG rooted-path
export const lazy = () => import("@capybara-hq/plugin-other"); // FLAG other-plugin
export const KERNEL = "@capybara-hq/kernel"; // FLAG name-string
export const SDK_SUBPATH = `@capybara-hq/plugin-tools/pack`; // FLAG name-template
export const UP = join(here, "..", "..", "..", "model-fake"); // FLAG bare-dotdot
export const UP_RESOLVE = resolve(here, "../..", ".."); // FLAG bare-dotdot-resolve
export const CWD_UP = join("..", "core"); // FLAG cwd-dotdot
export { createKernel, defineExtension, own, startFakeSlack, waitFor, x };
