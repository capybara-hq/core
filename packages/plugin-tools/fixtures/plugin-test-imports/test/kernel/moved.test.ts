// A plugin test may import the SDK, the client SDK (and its /testing fake host),
// @capybara-hq/testing, model-fake (by package name) and its own files; everything that reaches
// into core is reported (lines marked FLAG). A `#` subpath import is judged by its targets in the
// package.json `imports` map (every condition); one the map does not map is reported.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel } from "@capybara-hq/kernel"; // FLAG kernel-import
import type { ClientComponent } from "@capybara-hq/plugin-client";
import { renderWithFakeHost } from "@capybara-hq/plugin-client/testing";
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { x as own } from "@capybara-hq/plugin-slack";
import { startFakeSlack } from "@capybara-hq/testing";
import { waitFor } from "../../../../packages/core/test/helpers.js"; // FLAG relative-import
import { x } from "../../src/index.js";
import { renderWithFakeHost as viaAlias } from "#client-testing";
import { helper } from "#helpers/a";
import { z } from "#zod";
import { createKernel as k2 } from "#kernel"; // FLAG hash-kernel
import { waitFor as w2 } from "#core/helpers"; // FLAG hash-outside
import { c } from "#cond"; // FLAG hash-condition
import { m } from "#missing"; // FLAG hash-unmapped

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
export const CLIENT_TESTING = "@capybara-hq/plugin-client/testing";
export const DESIGN = "@capybara-hq/design"; // FLAG design-package
export const KERNEL = "@capybara-hq/kernel"; // FLAG name-string
export const SDK_SUBPATH = `@capybara-hq/plugin-tools/pack`; // FLAG name-template
export const UP = join(here, "..", "..", "..", "model-fake"); // FLAG bare-dotdot
export const UP_RESOLVE = resolve(here, "../..", ".."); // FLAG bare-dotdot-resolve
export const CWD_UP = join("..", "core"); // FLAG cwd-dotdot
export type { ClientComponent };
export { c, helper, k2, m, viaAlias, w2, z };
export { createKernel, defineExtension, own, renderWithFakeHost, startFakeSlack, waitFor, x };
