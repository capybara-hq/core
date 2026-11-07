import {
  defineExtension,
  orgAccess,
  secret,
  type WebSearchProvider,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Deployment schema with one field per org level (spec A §5.1): `host` hidden (no level),
 * `limit` read-only, `baseUrl` and `apiKey` overridable (an org may bring its own; the platform
 * may leave them empty, §5.4a).
 */
export const OrglevelsDeploymentSchema = z.object({
  host: z.string(),
  limit: orgAccess(z.number().default(5), "readonly"),
  baseUrl: orgAccess(z.string().url(), "override"),
  apiKey: orgAccess(secret(z.string()), "override"),
});

/** Org-only config (every org schema field is org only). */
export const OrglevelsOrgSchema = z.object({ team: z.string().optional() });

/**
 * The per-call config the kernel hands an org-bound call (spec A §6; added to the SDK later), read
 * loosely: whatever `config` arrives is echoed, so the tests see what the kernel passed.
 */
const perCallConfig = (x: unknown): Record<string, unknown> => {
  const c = (x as { config?: unknown } | undefined)?.config;
  return typeof c === "object" && c !== null ? (c as Record<string, unknown>) : {};
};

/**
 * Test plugin for platform / org layering: registers the tool `echo`, which returns the keys of
 * its per-call config, and provides `web-search@1`, whose one result carries the per-call config
 * (secret values replaced by "set") and the org config as JSON in its snippet.
 */
export default defineExtension({
  name: "orglevels",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1"],
  permissions: { tools: ["echo"] },
  config: { deployment: OrglevelsDeploymentSchema, org: OrglevelsOrgSchema },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "echo",
        description:
          "Return the names of the config fields this call received. Use it to check which configuration applies.",
        inputSchema: { type: "object", properties: {} },
        defaultPolicy: "allow",
      },
      async (_input, tctx) => ({
        content: [{ type: "text", text: JSON.stringify(Object.keys(perCallConfig(tctx)).sort()) }],
      }),
    );
    const search: WebSearchProvider = {
      async search(args) {
        const { apiKey, ...config } = perCallConfig(args);
        return {
          results: [
            {
              title: "orglevels",
              url: "https://orglevels.example/",
              snippet: JSON.stringify({
                config: { ...config, ...(apiKey !== undefined && { apiKey: "set" }) },
                orgConfig: args.orgConfig,
              }),
            },
          ],
        };
      },
    };
    ctx.provide("web-search@1", search);
  },
});
