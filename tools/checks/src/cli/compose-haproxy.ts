import { join } from "node:path";
import { checkComposeHaproxy } from "../compose-haproxy.js";
import { report, root } from "./report.js";

report(
  "compose haproxy",
  checkComposeHaproxy(
    join(root, "docker/compose.yaml"),
    join(root, "docker/sandbox-proxy/haproxy.cfg"),
  ),
);
