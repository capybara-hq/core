import { defineExtension, orgAccess } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Deployment schema with an object-level refinement across fields and one overridable field
 * (spec A §5.4a): in `strict` mode the endpoint must be https. The refinement reads `endpoint`
 * without guarding its absence, as real plugins do (openai-compatible's superRefine).
 */
export const OrgrefinedDeploymentSchema = z
  .object({
    mode: z.enum(["strict", "loose"]),
    endpoint: orgAccess(z.string(), "override"),
  })
  .superRefine((v, c) => {
    if (v.mode === "strict" && !v.endpoint.startsWith("https://")) {
      c.addIssue({ code: "custom", path: ["endpoint"], message: "strict mode needs https" });
    }
  });

/** Test plugin whose deployment schema is refined; it registers nothing. */
export default defineExtension({
  name: "orgrefined",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {},
  config: { deployment: OrgrefinedDeploymentSchema },
  setup() {},
});
