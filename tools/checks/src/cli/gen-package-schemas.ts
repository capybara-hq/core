import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SCHEMAS_DIR, PACKAGE_SCHEMAS, renderPackageSchema } from "../package-schemas.js";

mkdirSync(DEFAULT_SCHEMAS_DIR, { recursive: true });
for (const s of PACKAGE_SCHEMAS) {
  const file = join(DEFAULT_SCHEMAS_DIR, s.file);
  writeFileSync(file, renderPackageSchema(s));
  console.log(`已写入 ${file}`);
}
