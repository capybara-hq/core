import { checkMigrations } from "../migrations.js";
import { migrationDirs, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

requireScanTargets();

report("Migrations", checkMigrations(migrationDirs()));
