import { createOsExecutor } from "../src/exec/os.js";

// Drives the real OS sandbox but is not on the checked-in list.
export const exec = createOsExecutor;
