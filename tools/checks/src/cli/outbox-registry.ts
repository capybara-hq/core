import { checkOutboxRegistry } from "../outbox-registry.js";
import { report, root } from "./report.js";

report("Outbox registry", checkOutboxRegistry(root));
