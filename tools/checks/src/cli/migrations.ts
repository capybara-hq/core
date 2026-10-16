import { checkMigrations } from "../migrations.js";
import { migrationDirs } from "./dirs.js";
import { report } from "./report.js";

report("迁移", checkMigrations(migrationDirs()));
