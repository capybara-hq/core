import { createHash } from "node:crypto";
import { ToolError, type ToolResult, type WebFetchPage } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import {
  WEB_FETCH_SPEC,
  type WebFetchDeps,
  webFetchTool,
} from "../../src/tools/builtins/web/fetch.js";
import { WebPages } from "../../src/tools/builtins/web/page-cache.js";
import { specHash, ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff, onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Web tools spec §3.2, §4.2, §7.1, §10: `WebFetch` page fetching on a real kernel with the
 * scripted `fake-web` / `fake-web-2` providers (the URL path picks the provider's behavior); the
 * extraction model call is stubbed here.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, fakeExtensionEntry("fake-web"), fakeExtensionEntry("fake-web-2")],
      },
    ),
  );
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let ownerId: string;
let owner: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const enable = (org: string, plugin: string, token = "tok") =>
  k.app.get(OrgExtensionConfigs).put(org, plugin, { enabled: true, config: { token } }, ownerId);

/** What the extraction stub was called with. */
interface Extracted {
  page: WebFetchPage;
  prompt: string;
}

function tool(extracted: Extracted[] = []) {
  const deps: WebFetchDeps = {
    points: k.app.get(ExtensionPointDefaults),
    config: k.app.get(KernelConfigService),
    cache: k.app.get(WebPages),
    extract: async (_ctx, page, prompt) => {
      extracted.push({ page, prompt });
      return `answer to ${prompt}`;
    },
  };
  return webFetchTool(deps);
}

const callCtx = (org = orgId) => ({
  orgId: org,
  accountId: ownerId,
  agentId: "g",
  conversationId: "c",
  callId: "call",
  signal: new AbortController().signal,
});

const textOf = (r: unknown): string => {
  const c = (r as ToolResult).content[0];
  return c?.type === "text" ? c.text : "";
};

/** Every fetch call the fake providers recorded in this process. */
const fetchCalls = () =>
  (
    (globalThis as { __fakeWeb?: { calls: { provider: string; op: string; input: string }[] } })
      .__fakeWeb?.calls ?? []
  ).filter((c) => c.op === "fetch");
const callsOf = (url: string, provider?: string) =>
  fetchCalls().filter((c) => c.input === url && (provider === undefined || c.provider === provider))
    .length;

/** A URL no other test fetched (the page cache lives in Redis across tests). */
const unique = (script = "page") =>
  `https://example.com/${script}?n=${Math.random().toString(36).slice(2)}`;

describe("WebFetch: spec", () => {
  it("fixed spec: name, parameters, ask, read-only and open-world, not on the R3 list", () => {
    const t = tool();
    expect(t.spec).toBe(WEB_FETCH_SPEC);
    expect(t.spec.name).toBe("WebFetch");
    expect(t.defaultPolicy).toBe("ask");
    expect(t.spec.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(t.spec.keyArgs).toEqual(["url", "prompt"]);
    expect(t.spec.description).toBe(
      "Fetch a web page and answer a question about it. Pass the full URL and a prompt saying what " +
        "to extract; the page is read and a smaller model answers the prompt from it, so the result " +
        "is the answer, not the raw page. Use it after WebSearch, or when the user gives you a URL. " +
        "It is read-only. HTTP URLs are upgraded to HTTPS. If the URL redirects to another host, " +
        "the result tells you the new URL to fetch.",
    );
    const schema = t.spec.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["prompt", "url"]);
    expect(schema.required).toEqual(["url", "prompt"]);
    expect(t.spec.annotations?.requiresUserInteraction).not.toBe(true);
  });
});

describe("WebFetch: fetching", () => {
  it("a page: the stub gets the page and the prompt; the result is headed by the URL", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const url = unique();
    const r = (await tool(got).run({ url, prompt: "what?" }, callCtx())) as ToolResult;
    expect(got).toHaveLength(1);
    expect(got[0]?.prompt).toBe("what?");
    expect(got[0]?.page.finalUrl).toBe(url);
    expect(got[0]?.page.markdown).toBe(`# Page from fake-web\n\nFetched ${url} with fake-web.`);
    expect(textOf(r)).toBe(`URL: ${url}\n\nanswer to what?`);
    expect(r.display?.summary).toEqual({ en: "Read example.com", zh: "读取网页：example.com" });
  });

  it("http is upgraded to https before the provider is called", async () => {
    await enable(orgId, "fake-web");
    const url = unique();
    const got: Extracted[] = [];
    await tool(got).run({ url: url.replace("https:", "http:"), prompt: "p" }, callCtx());
    expect(callsOf(url, "fake-web")).toBe(1);
    expect(got[0]?.page.finalUrl).toBe(url);
  });

  it("a private URL is rejected before the provider is called", async () => {
    await enable(orgId, "fake-web");
    const before = fetchCalls().length;
    const p = tool().run({ url: "https://10.0.0.1/x", prompt: "p" }, callCtx());
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow(
      "Pass a full public https URL; this host is private or local. Then call WebFetch again.",
    );
    expect(fetchCalls().length).toBe(before);
  });

  it("redirect to another host → the exact redirect text, no extraction", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const r = await tool(got).run(
      { url: "https://example.com/redirect:https://other.com/x", prompt: "p" },
      callCtx(),
    );
    expect(textOf(r)).toBe(
      "The URL redirected to https://other.com/x. Call WebFetch again with that URL if you want its content.",
    );
    expect(got).toHaveLength(0);
  });

  it("redirect on the same host → extracted, with a Final URL line", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const url = "https://example.com/redirect:https://example.com/moved";
    const r = await tool(got).run({ url, prompt: "p" }, callCtx());
    expect(got).toHaveLength(1);
    expect(textOf(r)).toBe(`URL: ${url}\nFinal URL: https://example.com/moved\n\nanswer to p`);
  });

  it("redirect to a private host → a URL error, no extraction", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const p = tool(got).run(
      { url: "https://example.com/redirect:https://10.0.0.1/admin", prompt: "p" },
      callCtx(),
    );
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow(
      "The URL redirected to https://10.0.0.1/admin, which WebFetch cannot fetch; use another URL.",
    );
    expect(got).toHaveLength(0);
  });

  it("redirect to a final URL that does not parse → the generic text, not the URL", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const p = tool(got).run(
      { url: "https://example.com/redirect:not a url", prompt: "p" },
      callCtx(),
    );
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow(
      /^The URL redirected to an address WebFetch cannot fetch; use another URL\.$/,
    );
    expect(got).toHaveLength(0);
  });

  it("redirect to a final URL over 2000 characters → the generic text, not the URL", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const p = tool(got).run({ url: unique("redirect-long:3000"), prompt: "p" }, callCtx());
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow(
      /^The URL redirected to an address WebFetch cannot fetch; use another URL\.$/,
    );
    expect(got).toHaveLength(0);
  });

  it("apex ↔ www redirect counts as the same host: extracted, with a Final URL line", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    const toWww = "https://example.com/redirect:https://www.example.com/moved";
    const r = await tool(got).run({ url: toWww, prompt: "p" }, callCtx());
    expect(textOf(r)).toBe(
      `URL: ${toWww}\nFinal URL: https://www.example.com/moved\n\nanswer to p`,
    );
    const toApex = "https://www.example.com/redirect:https://example.com/moved";
    const r2 = await tool(got).run({ url: toApex, prompt: "p" }, callCtx());
    expect(textOf(r2)).toBe(`URL: ${toApex}\nFinal URL: https://example.com/moved\n\nanswer to p`);
    expect(got).toHaveLength(2);
  });

  it("www is the only prefix ignored: another subdomain or host is still a redirect", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    for (const target of ["https://docs.example.com/x", "https://www.other.com/x"]) {
      const r = await tool(got).run(
        { url: `https://example.com/redirect:${target}`, prompt: "p" },
        callCtx(),
      );
      expect(textOf(r)).toBe(
        `The URL redirected to ${target}. Call WebFetch again with that URL if you want its content.`,
      );
    }
    expect(got).toHaveLength(0);
  });

  it("timeoutMs comes from web.fetch.timeoutMs (read per call), also on the resolved tool", async () => {
    const real = k.app.get(KernelConfigService);
    expect(real.get().web.fetch.timeoutMs).toBe(180_000);
    await enable(orgId, "fake-web");
    const { tools } = await k.app
      .get(ToolRegistry)
      .forAgent(orgId, { source: "web", disabledTools: builtinsOff("WebFetch") });
    const resolved = tools.find((t) => t.key === "WebFetch");
    expect(resolved?.timeoutMs?.({ url: "https://example.com/", prompt: "p" })).toBe(180_000);
    let ms = 1234;
    const t = webFetchTool({
      points: k.app.get(ExtensionPointDefaults),
      cache: k.app.get(WebPages),
      extract: async () => "a",
      config: {
        get: () => {
          const c = real.get();
          return { ...c, web: { ...c.web, fetch: { ...c.web.fetch, timeoutMs: ms } } };
        },
      },
    });
    expect(t.timeoutMs?.({})).toBe(1234);
    ms = 5678;
    expect(t.timeoutMs?.({})).toBe(5678);
  });

  it("empty: → the empty-page error", async () => {
    await enable(orgId, "fake-web");
    const p = tool().run({ url: unique("empty:"), prompt: "p" }, callCtx());
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow("The page has no readable text; use another URL.");
  });

  it("big:500000 → the stub gets web.fetch.maxPageChars characters plus the marker", async () => {
    await enable(orgId, "fake-web");
    const got: Extracted[] = [];
    await tool(got).run({ url: unique("big:500000"), prompt: "p" }, callCtx());
    expect(got[0]?.page.markdown).toBe(`${"x".repeat(400_000)}\n[truncated]`);
  });

  it("error:auth → the fetch auth text", async () => {
    await enable(orgId, "fake-web");
    const p = tool().run({ url: unique("error:auth"), prompt: "p" }, callCtx());
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow(
      "The web fetch provider rejected its credentials; ask an org admin to check the provider's configuration.",
    );
  });

  it("no provider / ambiguous → unavailable with the exact reason", async () => {
    const t = tool();
    expect(await t.unavailable?.({ orgId })).toBe(
      "No web fetch provider is enabled in this organization; ask an org admin to enable one.",
    );
    await enable(orgId, "fake-web");
    expect(await t.unavailable?.({ orgId })).toBeNull();
    await enable(orgId, "fake-web-2");
    expect(await t.unavailable?.({ orgId })).toBe(
      "Several web fetch providers are enabled and none is the default; ask an org admin to choose one in the organization settings.",
    );
  });
});

describe("WebFetch: page cache", () => {
  it("the same URL again within the TTL is served from the cache; another org calls", async () => {
    await enable(orgId, "fake-web");
    const url = unique();
    const got: Extracted[] = [];
    await tool(got).run({ url, prompt: "a" }, callCtx());
    await tool(got).run({ url, prompt: "b" }, callCtx());
    expect(callsOf(url)).toBe(1);
    // the cached page, not the extraction: the second prompt was answered from the same page
    expect(got.map((g) => g.prompt)).toEqual(["a", "b"]);
    expect(got[1]?.page).toEqual(got[0]?.page);

    const orgB = await createOrg(owner, "Beta");
    await enable(orgB, "fake-web");
    await tool().run({ url, prompt: "c" }, callCtx(orgB));
    expect(callsOf(url)).toBe(2);
  });

  it("the key: cache:web_page:<orgId>:<provider>:<sha256(url)> (CacheService), TTL cacheSeconds", async () => {
    await enable(orgId, "fake-web");
    const url = unique();
    await tool().run({ url, prompt: "a" }, callCtx());
    const key = `cache:web_page:${orgId}:fake-web:${createHash("sha256").update(url).digest("hex")}`;
    const r = new Redis(rd.url);
    try {
      const ttl = await r.ttl(key);
      expect(ttl).toBeGreaterThan(800);
      expect(ttl).toBeLessThanOrEqual(900);
    } finally {
      r.disconnect();
    }
  });

  it("cacheSeconds: 0 → every fetch calls the provider", async () => {
    await enable(orgId, "fake-web");
    const config = k.app.get(KernelConfigService);
    const real = config.get();
    const spy = vi.spyOn(config, "get").mockImplementation(() => ({
      ...real,
      web: { ...real.web, fetch: { ...real.web.fetch, cacheSeconds: 0 } },
    }));
    try {
      const url = unique();
      await tool().run({ url, prompt: "a" }, callCtx());
      await tool().run({ url, prompt: "b" }, callCtx());
      expect(callsOf(url)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;
const results = (evs: ConversationEvent[]): ToolResultEvent["payload"][] =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));

describe("WebFetch: approval", { timeout: 90_000 }, () => {
  it("an always grant still applies after the org default moves to another provider", async () => {
    await enable(orgId, "fake-web");
    await enable(orgId, "fake-web-2");
    const points = k.app.get(ExtensionPointDefaults);
    await points.setDefault(orgId, "web-fetch", "fake-web", ownerId);

    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Reader",
          instructions: "Read pages.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "builtin", name: "WebFetch" }]),
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agentId = (res.json() as { agent: { id: string } }).agent.id;
    await db
      .insertInto("tool_grants")
      .values({
        org_id: orgId,
        account_id: ownerId,
        agent_id: agentId,
        tool_key: "WebFetch",
        spec_hash: specHash(WEB_FETCH_SPEC),
        connector_id: null,
      })
      .execute();

    // a redirect to another host returns without the extraction call
    const url = unique("redirect:https://other.com/next");
    const call = `tool:WebFetch:${JSON.stringify({ url, prompt: "p" })}`;
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, call);
    await waitForTerminal(db, conv, 1, 30_000);
    await points.setDefault(orgId, "web-fetch", "fake-web-2", ownerId);
    await postMessage(owner, orgId, conv, call);
    await waitForTerminal(db, conv, 2, 30_000);

    const evs = await eventsOf(db, conv);
    expect(evs.filter((e) => e.type === "approval_requested")).toHaveLength(0);
    const rs = results(evs);
    expect(rs.map((r) => r.isError)).toEqual([false, false]);
    expect(callsOf(url, "fake-web")).toBe(1);
    expect(callsOf(url, "fake-web-2")).toBe(1);
  });
});
