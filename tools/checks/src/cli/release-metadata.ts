import { checkReleaseMetadata } from "../release-metadata.js";
import { report, root } from "./report.js";

report("release metadata", checkReleaseMetadata(root));
