import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_NPM_REGISTRY } from "@capybara-hq/plugin-tools/pack";
import { checkBootstrap } from "../bootstrap.js";
import { report, root } from "./report.js";

// `--write` updates stale versions and integrities in bootstrap.json instead of reporting them.
// `--network` also checks the npm entries against the registry (`--registry`, default
// CAPYBARA_PACKAGES__NPM_REGISTRY or the public registry) and the official marketplace commit
// (`--marketplace-url` reads it from a mirror repository instead of `marketplace.url`).
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

report(
  values.network ? "Bootstrap manifest (with npm and the marketplace)" : "Bootstrap manifest",
  await checkBootstrap(join(root, "packages/kernel/bootstrap.json"), root, {
    write: values.write,
    ...(values.network && {
      network: { registry, ...(marketplaceUrl !== undefined && { marketplaceUrl }) },
    }),
  }),
);
