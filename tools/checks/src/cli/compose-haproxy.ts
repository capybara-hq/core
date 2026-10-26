import { join } from "node:path";
import { checkComposeHaproxy, checkHaproxyCopy, PLUGIN_HAPROXY_COPY } from "../compose-haproxy.js";
import { report, root } from "./report.js";

const cfg = join(root, "docker/sandbox-proxy/haproxy.cfg");
report("compose haproxy", [
  ...checkComposeHaproxy(join(root, "docker/compose.yaml"), cfg),
  ...checkHaproxyCopy(cfg, join(root, PLUGIN_HAPROXY_COPY)),
]);
