import { checkPackageSchemas } from "../package-schemas.js";
import { report } from "./report.js";

report("Package JSON Schema", checkPackageSchemas());
