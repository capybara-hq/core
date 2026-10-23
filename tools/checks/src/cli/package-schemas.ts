import { checkPackageSchemas } from "../package-schemas.js";
import { report } from "./report.js";

report("包 JSON Schema", checkPackageSchemas());
