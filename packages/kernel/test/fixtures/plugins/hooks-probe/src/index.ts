import {
  type AvailableHook,
  defineExtension,
  type ExtensionContext,
  HOOKS_AVAILABLE,
} from "@capybara-hq/plugin-sdk";

/**
 * Behavior per organization, set through `POST /config` (plugins cannot read their organization
 * config from a hook payload, so the test sets it through the plugin's own route; kept in ctx.kv).
 */
interface ProbeConfig {
  /** Tool keys the tool.preExecute policy hook denies with reason "nope". */
  denyTools?: string[];
  /** The model.request policy hook denies with reason "nope". */
  denyModel?: boolean;
  /** Mount points whose hook throws. */
  throwIn?: AvailableHook[];
  /** Hooks of the mount points in `sleepIn` wait this long (they stop early when aborted). */
  sleepMs?: number;
  sleepIn?: AvailableHook[];
  /** usage.report throws on the first delivery of each event (succeeds on the retry). */
  usageThrowOnce?: boolean;
  /** usage.report blocks on the first delivery of each event until its signal aborts. */
  usageHoldOnce?: boolean;
}

const TTL = { ttlSeconds: 600 };

/**
 * Test plugin for runtime hooks: registers every available mount point (policy on model.request /
 * tool.preExecute, observe elsewhere), counts calls per organization and keeps the last payload of
 * each mount in ctx.kv (with a TTL), readable through `GET /counts?orgId=` (`&conversationId=` for the
 * last payloads of one conversation). Also provides the tool
 * `probe_echo` (allowed by default) so tool hooks have something to guard.
 */
export default defineExtension({
  name: "hooks-probe",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: {
    hooks: [
      "model.request",
      "model.response",
      "tool.preExecute",
      "tool.postExecute",
      "usage.report",
    ],
    policyHooks: ["model.request", "tool.preExecute"],
    http: [
      { method: "GET", path: "/counts" },
      { method: "POST", path: "/config" },
      { method: "GET", path: "/usage" },
      { method: "GET", path: "/whoami" },
    ],
    tools: ["probe_echo"],
  },
  setup(ctx: ExtensionContext) {
    /** This plugin instance (per replica): lets a test tell which replica holds a delivery. */
    const instanceId = crypto.randomUUID();
    const config = async (orgId: string): Promise<ProbeConfig> =>
      JSON.parse((await ctx.kv.get(`cfg:${orgId}`)) ?? "{}") as ProbeConfig;
    const record = async (mount: AvailableHook, orgId: string, payload: unknown) => {
      await ctx.kv.incr(`count:${orgId}:${mount}`, TTL);
      await ctx.kv.set(`last:${orgId}:${mount}`, JSON.stringify(payload), TTL);
      // also per conversation, so a test can tell a sub-agent's payloads from its parent's
      const conv = (payload as { conversationId?: unknown }).conversationId;
      if (typeof conv === "string") {
        await ctx.kv.set(`lastc:${conv}:${mount}`, JSON.stringify(payload), TTL);
      }
    };
    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    const prelude = async (
      mount: AvailableHook,
      orgId: string,
      payload: unknown,
      signal: AbortSignal,
    ): Promise<ProbeConfig> => {
      await record(mount, orgId, payload);
      const cfg = await config(orgId);
      if (cfg.throwIn?.includes(mount)) throw new Error(`probe failure in ${mount}`);
      if (cfg.sleepMs && cfg.sleepIn?.includes(mount)) {
        await sleep(cfg.sleepMs, signal);
      }
      return cfg;
    };

    ctx.hooks.on(
      "model.request",
      async (p, signal) => {
        const cfg = await prelude("model.request", p.orgId, p, signal);
        return cfg.denyModel ? { deny: "nope" } : undefined;
      },
      { mode: "policy" },
    );
    ctx.hooks.on(
      "tool.preExecute",
      async (p, signal) => {
        const cfg = await prelude("tool.preExecute", p.orgId, p, signal);
        return cfg.denyTools?.includes(p.toolKey) ? { deny: "nope" } : undefined;
      },
      { mode: "policy" },
    );
    ctx.hooks.on(
      "model.response",
      async (p, signal) => {
        await prelude("model.response", p.orgId, p, signal);
      },
      { mode: "observe" },
    );
    ctx.hooks.on(
      "tool.postExecute",
      async (p, signal) => {
        await prelude("tool.postExecute", p.orgId, p, signal);
      },
      { mode: "observe" },
    );
    ctx.hooks.on(
      "usage.report",
      async (p, signal) => {
        const cfg = await prelude("usage.report", p.orgId, p, signal);
        // per event: deliveries and the last payload (idempotency is the handler's job: by eventId)
        const n = await ctx.kv.incr(`usage:${p.eventId}`, TTL);
        await ctx.kv.incr(`usage-by:${instanceId}`, TTL);
        await ctx.kv.set(`usage-last:${p.eventId}`, JSON.stringify(p), TTL);
        if (n === 1 && cfg.usageThrowOnce) throw new Error("probe usage failure (first delivery)");
        if (n === 1 && cfg.usageHoldOnce) {
          await ctx.kv.set(`usage-holder:${p.eventId}`, instanceId, TTL);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw new Error("probe usage delivery aborted");
        }
      },
      { mode: "observe" },
    );

    ctx.tools.register(
      {
        name: "probe_echo",
        description: "Echo the given text back. Use it to exercise tool hooks in tests.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "Text to echo back." } },
        },
        defaultPolicy: "allow",
      },
      async (input, tctx) => {
        await ctx.kv.incr(`count:${tctx.orgId}:handler`, TTL);
        return {
          content: [{ type: "text", text: `echo: ${(input as { text?: string }).text ?? ""}` }],
        };
      },
    );

    ctx.http.route("GET", "/counts", async (req) => {
      const params = new URL(req.url).searchParams;
      const orgId = params.get("orgId") ?? "";
      // with conversationId: `last` holds that conversation's last payload per mount
      const conv = params.get("conversationId");
      const counts: Record<string, number> = {};
      const last: Record<string, unknown> = {};
      for (const m of [...HOOKS_AVAILABLE, "handler"]) {
        counts[m] = Number((await ctx.kv.get(`count:${orgId}:${m}`)) ?? 0);
        const raw = await ctx.kv.get(conv === null ? `last:${orgId}:${m}` : `lastc:${conv}:${m}`);
        if (raw !== null) last[m] = JSON.parse(raw);
      }
      return Response.json({ counts, last });
    });
    ctx.http.route("GET", "/usage", async (req) => {
      const ids = (new URL(req.url).searchParams.get("eventIds") ?? "").split(",").filter(Boolean);
      const out: Record<string, { calls: number; last: unknown; holder: string | null }> = {};
      for (const id of ids) {
        const last = await ctx.kv.get(`usage-last:${id}`);
        out[id] = {
          calls: Number((await ctx.kv.get(`usage:${id}`)) ?? 0),
          last: last === null ? null : JSON.parse(last),
          holder: await ctx.kv.get(`usage-holder:${id}`),
        };
      }
      return Response.json(out);
    });
    ctx.http.route("GET", "/whoami", async () =>
      Response.json({
        instanceId,
        delivered: Number((await ctx.kv.get(`usage-by:${instanceId}`)) ?? 0),
      }),
    );
    ctx.http.route("POST", "/config", async (req) => {
      const { orgId, ...cfg } = (await req.json()) as ProbeConfig & { orgId: string };
      await ctx.kv.set(`cfg:${orgId}`, JSON.stringify(cfg), TTL);
      return Response.json({ ok: true });
    });
  },
});
