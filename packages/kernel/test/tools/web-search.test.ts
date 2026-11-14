import { ToolError, type ToolResult } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { TOOLS_UNAVAILABLE_PREFIX } from "../../src/runtime/model-call.js";
import { webToolError } from "../../src/tools/builtins/web/errors.js";
import { WEB_SEARCH_SPEC, webSearchTool } from "../../src/tools/builtins/web/search.js";
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
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Web tools spec §3.1, §3.3, §3.4, §4.2, §7.2: the `WebSearch` builtin on a real kernel with the
 * scripted `fake-web` / `fake-web-2` providers (the query prefix picks the provider's behavior).
 */

const TIMEOUT_MS = 2000;
const NONE_REASON =
  "No web search provider is enabled in this organization; ask an org admin to enable one.";
const AMBIGUOUS_REASON =
  "Several web search providers are enabled and none is the default; ask an org admin to choose one in the organization settings.";
const AUTH_TEXT =
  "The web search provider rejected its credentials; ask an org admin to check the provider's configuration.";
const CITE = "Cite the sources you use as markdown links in your answer.";

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
        tools: { timeoutMs: TIMEOUT_MS },
      },
    ),
  );
});
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

const tool = (now = () => new Date("2026-11-04T23:30:00Z")) =>
  webSearchTool({
    points: k.app.get(ExtensionPointDefaults),
    config: k.app.get(KernelConfigService),
    now,
  });

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

async function createWebAgent(org = orgId): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${org}/agents`,
    payload: {
      definition: {
        name: "Researcher",
        instructions: "Search the web.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "WebSearch" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** Remembers an "always" grant so the call runs without an approval card. */
async function grantAlways(agentId: string, org = orgId): Promise<void> {
  await db
    .insertInto("tool_grants")
    .values({
      org_id: org,
      account_id: ownerId,
      agent_id: agentId,
      tool_key: "WebSearch",
      spec_hash: specHash(WEB_SEARCH_SPEC),
      connector_id: null,
    })
    .execute();
}

const search = (query: string, more: Record<string, unknown> = {}) =>
  `tool:WebSearch:${JSON.stringify({ query, ...more })}`;

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;
const results = (evs: ConversationEvent[]): ToolResultEvent["payload"][] =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));

/** Runs one search in a new conversation (granted) and returns its tool_result. */
async function searchOnce(query: string): Promise<ToolResultEvent["payload"]> {
  const agentId = await createWebAgent();
  await grantAlways(agentId);
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, search(query));
  await waitForTerminal(db, conv, 1, 30_000);
  const [r] = results(await eventsOf(db, conv));
  if (!r) throw new Error("no tool_result");
  return r;
}

describe("WebSearch: spec", () => {
  it("fixed spec: name, parameters, ask, read-only and open-world, not on the R3 list", () => {
    const t = tool();
    expect(t.spec).toBe(WEB_SEARCH_SPEC);
    expect(t.spec.name).toBe("WebSearch");
    expect(t.defaultPolicy).toBe("ask");
    expect(t.spec.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(t.spec.keyArgs).toEqual(["query"]);
    expect(t.spec.description).toBe(
      "Search the web and get a list of results with title, URL and a short snippet. Use it for " +
        "information newer than your training data, or to check whether something you know is still " +
        "current. Then use WebFetch to read the pages you need. Do not use it for questions you can " +
        "answer reliably without the web. Cite the sources you use.",
    );
    expect(t.spec.description).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const schema = t.spec.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "allowed_domains",
      "blocked_domains",
      "query",
    ]);
    expect(schema.required).toEqual(["query"]);
    expect(t.spec.annotations?.requiresUserInteraction).not.toBe(true);
  });
});

describe("WebSearch: result", () => {
  it("date line first, numbered entries with title, URL, date and snippet, cite line last", async () => {
    await enable(orgId, "fake-web");
    const text = textOf(await tool().run({ query: "hello" }, callCtx()));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Search date: 2026-11-04 (UTC).");
    expect(lines.at(-1)).toBe(CITE);
    expect(text).toContain(
      "1. fake-web result 1\n   URL: https://docs.example.com/fake-web/1\n" +
        "   Published: 2026-11-01\n   fake-web snippet 1 for hello",
    );
    expect(text).toContain("2. fake-web result 2\n   URL: https://example.org/fake-web/2");
    expect(text).toContain("3. fake-web result 3\n   URL: https://www.example.net/fake-web/3");
    expect(text).not.toContain("4. ");
  });

  it("at most web.search.maxResults entries, however many the provider returns", async () => {
    await enable(orgId, "fake-web");
    const text = textOf(await tool().run({ query: "big:15" }, callCtx()));
    expect(text).toContain("10. fake-web result 10");
    expect(text).not.toContain("11. ");
  });

  it("allowed_domains keeps a subdomain and drops others; blocked_domains the reverse", async () => {
    await enable(orgId, "fake-web");
    const allowed = textOf(
      await tool().run({ query: "q", allowed_domains: ["Example.com"] }, callCtx()),
    );
    expect(allowed).toContain("https://docs.example.com/fake-web/1");
    expect(allowed).not.toContain("example.org");
    expect(allowed).not.toContain("example.net");
    const blocked = textOf(
      await tool().run({ query: "q", blocked_domains: ["example.com"] }, callCtx()),
    );
    expect(blocked).not.toContain("docs.example.com");
    expect(blocked).toContain("1. fake-web result 2\n   URL: https://example.org/fake-web/2");
    expect(blocked).toContain("https://www.example.net/fake-web/3");
  });

  it("a Unicode domain entry matches its punycode result host (IDNA before matching)", async () => {
    await enable(orgId, "fake-web");
    const allowed = textOf(
      await tool().run({ query: "idn:x", allowed_domains: ["BÜCHER.example"] }, callCtx()),
    );
    expect(allowed).toContain("1. fake-web idn\n   URL: https://xn--bcher-kva.example/fake-web/1");
    expect(allowed).not.toContain("example.org");
    const blocked = textOf(
      await tool().run({ query: "idn:x", blocked_domains: ["bücher.example"] }, callCtx()),
    );
    expect(blocked).not.toContain("xn--bcher-kva");
    expect(blocked).toContain("1. fake-web other\n   URL: https://example.org/fake-web/2");
  });

  it("both domain lists → an error naming both fields", async () => {
    await enable(orgId, "fake-web");
    const p = tool().run(
      { query: "q", allowed_domains: ["a.com"], blocked_domains: ["b.com"] },
      callCtx(),
    );
    await expect(p).rejects.toBeInstanceOf(ToolError);
    await expect(p).rejects.toThrow(/allowed_domains.*blocked_domains/);
  });

  it("unusable results are dropped (relative, javascript:, ftp:, untitled, duplicate URL)", async () => {
    await enable(orgId, "fake-web");
    const text = textOf(await tool().run({ query: "junk:x" }, callCtx()));
    expect(text).toContain("1. fake-web first\n   URL: https://example.com/dup");
    expect(text).not.toContain("2. ");
    for (const bad of ["relative", "javascript:", "ftp:", "untitled", "again"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("all dropped → No results.", async () => {
    await enable(orgId, "fake-web");
    const text = textOf(await tool().run({ query: "junk:all" }, callCtx()));
    expect(text.split("\n")[0]).toBe("Search date: 2026-11-04 (UTC).");
    expect(text).toContain("No results.");
    expect(text).not.toContain("1. ");
  });

  it("display summary in zh and en", async () => {
    await enable(orgId, "fake-web");
    const r = (await tool().run({ query: "hello" }, callCtx())) as ToolResult;
    expect(r.display?.summary.en).toBe("Searched the web: hello (3 results)");
    expect(r.display?.summary.zh).toBe("搜索网页：hello（3 条结果）");
  });
});

describe("WebSearch: provider errors", () => {
  it("maps each WebProviderError kind to a fixed text; anything else is rethrown", () => {
    const err = (kind: string) => Object.assign(new Error("x"), { name: "WebProviderError", kind });
    const msg = (e: unknown, t: "search" | "fetch") => {
      try {
        webToolError(e, t);
      } catch (x) {
        return x;
      }
      throw new Error("did not throw");
    };
    expect((msg(err("auth"), "search") as Error).message).toBe(AUTH_TEXT);
    expect((msg(err("rate_limited"), "search") as Error).message).toBe(
      "The web search provider is rate limiting this org; retry in a minute or continue without it.",
    );
    expect((msg(err("auth"), "fetch") as Error).message).toBe(
      "The web fetch provider rejected its credentials; ask an org admin to check the provider's configuration.",
    );
    expect((msg(err("not_found"), "search") as Error).message).toBe(
      "No results or page found; check the query or URL and retry.",
    );
    expect((msg(err("blocked"), "search") as Error).message).toBe(
      "The site refused the provider; use another source.",
    );
    expect((msg(err("unavailable"), "search") as Error).message).toBe(
      "The web provider is unavailable right now; retry later or continue without it.",
    );
    expect((msg(err("invalid"), "search") as Error).message).toBe(
      "The provider rejected the request; check the query or URL and retry.",
    );
    for (const k of ["auth", "invalid"]) expect(msg(err(k), "search")).toBeInstanceOf(ToolError);
    const plain = new Error("boom");
    expect(msg(plain, "search")).toBe(plain);
  });

  it("error:auth → the auth text as the tool result", async () => {
    await enable(orgId, "fake-web");
    const r = await searchOnce("error:auth");
    expect(r.isError).toBe(true);
    expect(r.content).toBe(AUTH_TEXT);
  });

  it("throw: → the generic failure text, without the provider's message", async () => {
    await enable(orgId, "fake-web");
    const r = await searchOnce("throw:secret-detail");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Tool WebSearch failed \(Error\)\./);
    expect(r.content).not.toContain("secret-detail");
    expect(r.content).not.toContain("fake-web");
  });

  it("hang: → the timeout text within tools.timeoutMs; the call is counted in flight meanwhile", async () => {
    await enable(orgId, "fake-web");
    const agentId = await createWebAgent();
    await grantAlways(agentId);
    const conv = await createConv(owner, orgId, agentId);
    const inst = () => k.app.get(ExtensionRegistry).current("fake-web");
    await postMessage(owner, orgId, conv, search("hang:"));
    // the provider call is in the instance's in-flight tracker (drained on disable / upgrade);
    // a generous deadline under load: the call may start late, the waitFor fails only if never seen
    await waitFor(
      async () => ((inst()?.inflight.size ?? 0) > 0 ? true : null),
      30_000,
      "in flight",
    );
    await waitForTerminal(db, conv, 1, 30_000);
    const [r] = results(await eventsOf(db, conv));
    expect(r?.isError).toBe(true);
    expect(r?.content).toBe(
      `Tool WebSearch timed out after ${TIMEOUT_MS / 1000}s. The operation may or may not have completed; verify before retrying.`,
    );
    // the timeout text above proves the pipeline's limit ended the call (no wall-clock bound:
    // it is not load-tolerant)
    await waitFor(async () => (inst()?.inflight.size === 0 ? true : null), 30_000, "drained");
  });
});

describe("WebSearch: approval", () => {
  it("asks on the first call; a session grant covers this conversation only", async () => {
    await enable(orgId, "fake-web");
    const agentId = await createWebAgent();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, search("first"));
    const asked = await waitForEvent(db, conv, (e) => e.type === "approval_requested", 30_000);
    const approvalId = asked.type === "approval_requested" && asked.payload.approvalId;
    const dec = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve", scope: "session" },
    });
    expect(dec.statusCode, dec.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    await postMessage(owner, orgId, conv, search("second"));
    await waitForTerminal(db, conv, 2, 30_000);
    const evs = await eventsOf(db, conv);
    expect(evs.filter((e) => e.type === "approval_requested")).toHaveLength(1);
    expect(results(evs).map((r) => r.isError)).toEqual([false, false]);

    const other = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, other, search("third"));
    await waitForEvent(db, other, (e) => e.type === "approval_requested", 30_000);
  });
});

describe("WebSearch: availability", () => {
  it("no provider / ambiguous → unavailable with the exact reason", async () => {
    const t = tool();
    expect(await t.unavailable?.({ orgId })).toBe(NONE_REASON);
    await enable(orgId, "fake-web");
    expect(await t.unavailable?.({ orgId })).toBeNull();
    await enable(orgId, "fake-web-2");
    expect(await t.unavailable?.({ orgId })).toBe(AMBIGUOUS_REASON);
  });

  it("an org without a provider: the tool is not offered, nothing is reported, the run continues", async () => {
    const agentId = await createWebAgent();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:hi");
    const [end] = await waitForTerminal(db, conv, 1, 30_000);
    expect(end?.type).toBe("run_finished");
    const reminders = (await eventsOf(db, conv)).flatMap((e) =>
      e.type === "reminder" ? [e.payload.text] : [],
    );
    // tools are on by default: one that cannot run is left out, never reported as unavailable
    expect(reminders.some((r) => r.startsWith(TOOLS_UNAVAILABLE_PREFIX))).toBe(false);
    const calls = (await eventsOf(db, conv)).flatMap((e) =>
      e.type === "model_call" ? [e.payload.request.tools?.map((t) => t.key) ?? []] : [],
    );
    expect(calls[0]).not.toContain("WebSearch");
    const why = await k.app
      .get(ToolRegistry)
      .forAgent(orgId, { source: "web", disabledTools: builtinsOff("WebSearch") });
    expect(why.hidden).toEqual([{ ref: "WebSearch", reason: NONE_REASON }]);
  });

  it("specHash is the same in two orgs using different providers", async () => {
    await enable(orgId, "fake-web");
    const orgB = await createOrg(owner, "Beta");
    await enable(orgB, "fake-web-2");
    const def = { disabledTools: builtinsOff("WebSearch") };
    const reg = k.app.get(ToolRegistry);
    const a = (await reg.forAgent(orgId, { ...def, source: "web" })).tools.find(
      (t) => t.key === "WebSearch",
    );
    const b = (await reg.forAgent(orgB, { ...def, source: "web" })).tools.find(
      (t) => t.key === "WebSearch",
    );
    expect(a?.specHash).toBeDefined();
    expect(a?.specHash).toBe(b?.specHash);
    // and each org's call goes to its own provider
    const ra = textOf(await tool().run({ query: "q" }, callCtx(orgId)));
    const rb = textOf(await tool().run({ query: "q" }, callCtx(orgB)));
    expect(ra).toContain("fake-web result 1");
    expect(rb).toContain("fake-web-2 result 1");
  });
});
