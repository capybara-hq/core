import { defineExtension, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

const T = (zh: string, en: string) => ({ zh, en });

/**
 * A hand-made extension whose deployment config hints are invalid (an option outside the enum, which
 * the packer would refuse): it still loads, without `x-ui` in its deployment schema. Its org config
 * hints are valid and pass through.
 */
export default defineExtension({
  name: "badhints",
  version: "0.3.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      mode: ui(z.enum(["a", "b"]).default("a"), {
        label: T("模式", "Mode"),
        options: [{ value: "c", label: T("丙", "C") }],
      }),
      greeting: z.string().default("hi").meta({ hot: true }),
    }),
    org: ui(
      z
        .object({
          team: ui(z.string().default("core").meta({ hot: true }), { label: T("团队", "Team") }),
        })
        .refine((v) => v.team !== "taken", { params: { ui: "taken" } }),
      { messages: { taken: T("已被占用", "Already taken") } },
    ),
  },
  setup() {},
});
