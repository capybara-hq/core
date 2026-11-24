import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  checkDeviceImagePin,
  checkDeviceImagePinNetwork,
  DEVICE_IMAGE_PIN_FILE,
  DEVICE_SOURCE_DIR,
} from "../device-image-pin.js";
import { report, root } from "./report.js";

// Offline: the pin's shape (every PR, in `pnpm check`). `--network`: the pinned digests exist in
// the registry and agree with the version tag (CI when the pin or this check changes, release.yml).
const { values } = parseArgs({ options: { network: { type: "boolean", default: false } } });
const file = join(root, DEVICE_IMAGE_PIN_FILE);

report(
  values.network ? "Device image pin (with the registry)" : "Device image pin",
  values.network
    ? await checkDeviceImagePinNetwork(file)
    : checkDeviceImagePin(file, join(root, DEVICE_SOURCE_DIR)),
);
