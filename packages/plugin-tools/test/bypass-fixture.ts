import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../fixtures/plugin-bypass-test-dir", import.meta.url));

/** 藏在 src/dist 里的违规代码：import 内核、模块级 let、定时器。 */
const DIST_IMPL = `import { createKernel } from "@capybara-hq/kernel";

let hidden = 0;
setTimeout(() => {}, 1);
export { createKernel, hidden };
`;

/**
 * 生成「把违规代码藏进 test / dist 子目录」的插件样本，返回插件目录与清理函数。
 *
 * 仓库的 .gitignore 一律忽略 dist 目录，所以 src/dist/impl.ts 不能入库，
 * 这里把入库的那部分复制到临时目录后现场写入它。目录名保持
 * plugin-bypass-test-dir，测试按这个片段截取相对路径。
 */
export function bypassFixture(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "capybara-bypass-"));
  const dir = join(base, "plugin-bypass-test-dir");
  cpSync(SOURCE, dir, { recursive: true });
  mkdirSync(join(dir, "src", "dist"), { recursive: true });
  writeFileSync(join(dir, "src", "dist", "impl.ts"), DIST_IMPL);
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
