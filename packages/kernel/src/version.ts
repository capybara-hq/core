import { createRequire } from "node:module";

/**
 * 内核版本（`@capybara-hq/kernel` 的 package.json `version`；src 与 dist 都在包根下一层，同一个相对路径）。
 * 清单条目的 `minKernel` 按它判断兼容。
 */
export const KERNEL_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
