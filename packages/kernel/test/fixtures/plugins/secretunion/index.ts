import { defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * The deployment config puts a secret inside a discriminatedUnion: the kernel cannot split the
 * secret out by object path, so loading must fail.
 */
export default defineExtension({
  name: "secretunion",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      auth: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("token"), token: secret(z.string()) }),
      ]),
    }),
  },
  setup() {
    throw new Error("setup must not run");
  },
});
