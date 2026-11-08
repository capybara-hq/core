import {
  type Directory,
  defineExtension,
  orgAccess,
  secret,
  type WebFetchProvider,
  type WebSearchProvider,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** One org-bound call the kernel made: where, for which org, and the per-call config it passed. */
export interface OrgCall {
  site: string;
  orgId: string;
  /** The per-call config with the secret `apiKey` replaced by "set". */
  config: unknown;
}

/** Test observation point (single-replica tests in the same process). */
export const orgCalls = (): OrgCall[] => {
  const g = globalThis as { __orgCalls?: OrgCall[] };
  g.__orgCalls ??= [];
  return g.__orgCalls;
};

const shown = (config: unknown): unknown => {
  if (typeof config !== "object" || config === null) return config;
  const { apiKey, ...rest } = config as Record<string, unknown>;
  return { ...rest, ...(apiKey !== undefined && { apiKey: "set" }) };
};

const record = (site: string, orgId: string, config: unknown) => {
  orgCalls().push({ site, orgId, config: shown(config) });
};

const t = (zh: string, en: string) => ({ zh, en });

/**
 * Test plugin for layering spec A §6: every org-bound callback records the per-call `config` it
 * received (`orgCalls()`). `baseUrl` and the secret `apiKey` are overridable, so an org may keep a
 * copy. Provides `web-search@1`, `web-fetch@1` and `directory@1`, the tool `probe`, the org page
 * view `page` (render and action), and hooks: `model.request` policy and observe, `usage.report`.
 */
export default defineExtension({
  name: "orgcalls",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1", "web-fetch@1", "directory@1"],
  ui: [{ id: "page", title: t("组织页", "Org page"), slot: "org.page", kind: "view" }],
  permissions: {
    tools: ["probe"],
    ui: { views: ["page"] },
    hooks: ["model.request", "usage.report"],
    policyHooks: ["model.request"],
  },
  config: {
    deployment: z.object({
      baseUrl: orgAccess(z.string(), "override"),
      apiKey: orgAccess(secret(z.string()), "override"),
    }),
  },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "probe",
        description:
          "Report which configuration this call received. Use it to check the organization's settings.",
        inputSchema: { type: "object", properties: {} },
        defaultPolicy: "allow",
      },
      async (_input, tctx) => {
        record("tool", tctx.orgId, tctx.config);
        return { content: [{ type: "text", text: "probed" }] };
      },
    );
    const search: WebSearchProvider = {
      configured(_orgConfig, config) {
        // the copy's value reaches configured() too; "off" switches the provider off in the org
        return (config as { baseUrl?: string } | undefined)?.baseUrl !== "off";
      },
      async search(args) {
        // the search args carry no org: the tests read the snippet
        record("web-search", "?", args.config);
        return {
          results: [
            {
              title: "orgcalls",
              url: "https://orgcalls.example/",
              snippet: JSON.stringify(shown(args.config)),
            },
          ],
        };
      },
    };
    const fetch: WebFetchProvider = {
      async fetch(args) {
        return {
          finalUrl: args.url,
          markdown: `config ${JSON.stringify(shown(args.config))}`,
        };
      },
    };
    const directory: Directory = {
      async listMembers(args) {
        record("directory", "?", args.config);
        return { members: [] };
      },
    };
    ctx.provide("web-search@1", search);
    ctx.provide("web-fetch@1", fetch);
    ctx.provide("directory@1", directory);
    ctx.ui.view("page", async (args) => {
      record("ui.render", args.orgId ?? "platform", args.config);
      return { blocks: [{ type: "text", markdown: JSON.stringify(shown(args.config)) }] };
    });
    ctx.ui.action("page", async (args) => {
      record("ui.action", args.orgId ?? "platform", args.config);
      return { toast: t("好", "ok") };
    });
    ctx.hooks.on(
      "model.request",
      (payload, _signal, call) => {
        record("model.request:policy", payload.orgId, call?.config);
      },
      { mode: "policy" },
    );
    ctx.hooks.on(
      "model.request",
      (payload, _signal, call) => {
        record("model.request:observe", payload.orgId, call?.config);
      },
      { mode: "observe" },
    );
    ctx.hooks.on(
      "usage.report",
      (payload, _signal, call) => {
        record("usage.report", payload.orgId, call?.config);
      },
      { mode: "observe" },
    );
  },
});
