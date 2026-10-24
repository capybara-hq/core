// 违规 fixture：各种形态的 import @capybara-hq/kernel（以及它的子路径）。
import { createKernel } from "@capybara-hq/kernel";
import type { Kernel } from "@capybara-hq/kernel";
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { zod } from "zod";

export { KERNEL_SCHEMA } from "@capybara-hq/kernel";
export * from "@capybara-hq/kernel/config";

export const lazy = () => import("@capybara-hq/kernel");
export const legacy = () => require("@capybara-hq/kernel");
export type Dyn = import("@capybara-hq/kernel").Kernel;
export { createKernel, defineExtension, zod };
export type { Kernel };
