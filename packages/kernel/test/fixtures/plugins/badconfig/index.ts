import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default definePlugin({
  name: "badconfig",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  config: { deployment: z.object({ port: z.number() }) },
  setup() {},
});
