import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMigrations } from "../migrations.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** 只扫描 packages/*\/src/migrations 与 plugins/*\/migrations；fixtures 不在扫描范围内。 */
function scanDirs(): string[] {
  const dirs: string[] = [];
  const sub = (base: string, rest: string) => {
    const b = join(root, base);
    if (!existsSync(b)) return;
    for (const e of readdirSync(b, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(join(b, e.name, rest));
    }
  };
  sub("packages", "src/migrations");
  sub("plugins", "migrations");
  return dirs;
}

const findings = checkMigrations(scanDirs());
for (const f of findings) {
  console.error(`${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
}
if (findings.length > 0) {
  console.error(`\n迁移检查失败：${findings.length} 条问题`);
  process.exit(1);
}
console.log("迁移检查通过");
