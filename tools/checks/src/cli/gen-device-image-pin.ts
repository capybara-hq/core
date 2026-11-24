import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEVICE_IMAGE_PIN_FILE, resolvePin, writePin } from "../device-image-pin.js";
import { root } from "./report.js";

// `pnpm gen:device-image-pin <version>`: reads the published sandbox image's index and per-platform
// manifests from the registry and rewrites the digest pin of capybara-device (docker-image.ts).
const { positionals } = parseArgs({ allowPositionals: true });
const version = positionals[0];
if (version === undefined || positionals.length !== 1) {
  console.error("usage: pnpm gen:device-image-pin <version>   (e.g. 0.1.0-rc.5)");
  process.exit(2);
}
const pin = await resolvePin(version);
const file = join(root, DEVICE_IMAGE_PIN_FILE);
const changed = writePin(file, pin);
console.log(
  `${changed ? "wrote" : "unchanged"} ${DEVICE_IMAGE_PIN_FILE}: ${pin.repository}:${pin.version} = ${pin.index}`,
);
if (changed)
  console.log(
    "The pin is part of the device's attested helper bytes: add a changeset bumping @capybara-hq/device.",
  );
