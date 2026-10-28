import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_NPM_REGISTRY } from "@capybara-hq/plugin-tools/pack";
import { BOOTSTRAP_COMPOSE_FILES, checkBootstrap, SANDBOX_PROXY_HAPROXY } from "../bootstrap.js";
import { report, root } from "./report.js";

// `--write` updates stale versions and integrities in bootstrap.json instead of reporting them.
// `--network` also checks the npm entries against the registry (`--registry`, default
// CAPYBARA_PACKAGES__NPM_REGISTRY or the public registry) and the official marketplace commit
// (`--marketplace-url` reads it from a mirror repository instead of `marketplace.url`);
// CAPYBARA_PACKAGES__NPM_TOKEN is sent to a private registry's origin. The compose files' git build
// contexts of the plugins repository are checked against marketplace.commit (offline), and with
// --network their Dockerfiles and the sandbox-docker plugin's copy of the socket proxy config there.
const { values } = parseArgs({
  options: {
    write: { type: "boolean", default: false },
    network: { type: "boolean", default: false },
    registry: { type: "string" },
    "marketplace-url": { type: "string" },
  },
});
const registry =
  values.registry ?? (process.env.CAPYBARA_PACKAGES__NPM_REGISTRY || DEFAULT_NPM_REGISTRY);
const marketplaceUrl = values["marketplace-url"];
const npmToken = process.env.CAPYBARA_PACKAGES__NPM_TOKEN || undefined;

report(
  values.network ? "Bootstrap manifest (with npm and the marketplace)" : "Bootstrap manifest",
  await checkBootstrap(join(root, "packages/kernel/bootstrap.json"), root, {
    write: values.write,
    composeFiles: BOOTSTRAP_COMPOSE_FILES.map((f) => join(root, f)),
    haproxyFile: join(root, SANDBOX_PROXY_HAPROXY),
    ...(values.network && {
      network: {
        registry,
        ...(marketplaceUrl !== undefined && { marketplaceUrl }),
        ...(npmToken !== undefined && { npmToken }),
      },
    }),
  }),
);
