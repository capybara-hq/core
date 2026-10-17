import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "../source.js";

/** 仓库根目录。 */
export const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** 打印 findings，有问题则以 1 退出。 */
export function report(name: string, findings: Finding[]): void {
  for (const f of findings) {
    console.error(`${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
  }
  if (findings.length > 0) {
    console.error(`\n${name}检查失败：${findings.length} 条问题`);
    process.exit(1);
  }
  console.log(`${name}检查通过`);
}
