import { checkKernelConventions } from "../kernel-conventions.js";
import { report, root } from "./report.js";

report("Kernel conventions", checkKernelConventions(root));
