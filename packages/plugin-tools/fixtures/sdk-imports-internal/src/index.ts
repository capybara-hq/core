// 违规 fixture：plugin-sdk 不得依赖任何其他 @capybara-hq/*。
import type { Kernel } from "@capybara-hq/kernel";
import { z } from "zod";

export type K = Kernel;
export const s = z.string();
