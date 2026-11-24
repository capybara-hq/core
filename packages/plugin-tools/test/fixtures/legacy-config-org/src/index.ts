// Violation: config.org was removed by core#720; the packer refuses it with a migration hint.
import { z } from "zod";

export default {
  name: "fixture-legacy-org",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: z.object({ url: z.string() }), org: z.object({ token: z.string() }) },
  setup() {},
};
