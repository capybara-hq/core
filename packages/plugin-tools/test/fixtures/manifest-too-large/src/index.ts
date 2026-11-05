// Fixture: two config schemas each under the 96 KiB cap (compact JSON) and the field limit, whose
// pretty-printed plugin.json is over PLUGIN_MANIFEST_LIMITS.manifestChars: the packer refuses it.
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

const wide = () => {
  let s: z.ZodTypeAny = z.object(
    Object.fromEntries(
      Array.from({ length: 900 }, (_, i) => [
        `field${String(i).padStart(4, "0")}`,
        z.string().optional().describe("d".repeat(50)),
      ]),
    ),
  );
  // nesting deepens the indentation of every pretty-printed line
  for (let k = 0; k < 4; k++) s = z.object({ n: s });
  return s as z.ZodObject;
};

export default defineExtension({
  name: "fixture-manifest-too-large",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: wide(), org: wide() },
  setup() {},
});
