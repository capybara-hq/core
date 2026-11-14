import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RUN_CONTEXT_CLOCK, RunContextService } from "../../src/runtime/run-context.service.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Run context (spec 2026-11-08-run-context-design): what a message records about its sender, the
 * person's time zone preference, the org default, and what run start writes.
 */

const capture = captureProviderRequests();
const PUBLIC_URL = "https://capybara.example.com";
let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let clockMs: number | null = null;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        // the attribution's conversation link is resolved against http.publicUrl
        http: { port: 0, publicUrl: PUBLIC_URL },
      },
    ),
    {
      overrides: [{ provide: RUN_CONTEXT_CLOCK, useValue: () => clockMs ?? Date.now() }],
    },
  );
});
afterAll(async () => {
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Wang Fang" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Grant",
        description: "Answers HR policy questions.",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff(),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  clockMs = null;
  capture.reset();
});

type UserPayload = EventPayload<"user_message">;

async function send(
  conv: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<ConversationEvent> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: { text, ...extra },
  });
  expect(res.statusCode, res.body).toBe(202);
  return (res.json() as { event: ConversationEvent }).event;
}

const contexts = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e) => e.type === "run_context").map((e) => e.payload);

/** The platform's default attribution (no startup config, no admin console choice). */
const ATTRIBUTION = {
  commit: "Co-Authored-By: Capybara <noreply@capybarahq.com>",
  pr: "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)",
  sessionUrl: null,
};

describe("message sender, time zone and language", () => {
  it("records the sender at send time; the browser's zone and language, else the org's", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const first = await send(conv, "echo:one", { timeZone: "Asia/Shanghai", locale: "zh" });
    expect(first.payload as UserPayload).toMatchObject({
      sender: { name: "Wang Fang", role: "owner" },
      timeZone: "Asia/Shanghai",
      locale: "zh",
    });
    await waitForTerminal(db, conv, 1, 30_000);
    // an unknown zone is ignored, never a 400: the org default (UTC); no language sent: the
    // person's latest web language (the first message's), not the org's
    const second = await send(conv, "echo:two", { timeZone: "Not/AZone" });
    expect(second.payload as UserPayload).toMatchObject({ timeZone: "UTC", locale: "zh" });
    await waitForTerminal(db, conv, 2, 30_000);
    // a rename afterwards leaves the logged messages unchanged
    await db
      .updateTable("accounts")
      .set({ display_name: "W. Fang" })
      .where("id", "=", ownerId)
      .execute();
    const logged = (await eventsOf(db, conv)).find((e) => e.seq === first.seq);
    expect((logged?.payload as UserPayload | undefined)?.sender?.name).toBe("Wang Fang");
  });

  it("the account setting overrides the browser; null follows it again", async () => {
    const prefs = "/api/v1/me/preferences";
    expect((await owner({ method: "GET", url: prefs })).json()).toEqual({
      timeZone: null,
      theme: null,
    });
    const bad = await owner({ method: "PUT", url: prefs, payload: { timeZone: "Mars/Olympus" } });
    expect(bad.statusCode).toBe(400);
    const set = await owner({ method: "PUT", url: prefs, payload: { timeZone: "Europe/Berlin" } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ timeZone: "Europe/Berlin", theme: null });
    const conv = await createConv(owner, orgId, agentId);
    const a = await send(conv, "echo:a", { timeZone: "Asia/Shanghai", locale: "zh" });
    expect((a.payload as UserPayload).timeZone).toBe("Europe/Berlin");
    await waitForTerminal(db, conv, 1, 30_000);
    await owner({ method: "PUT", url: prefs, payload: { timeZone: null } });
    const b = await send(conv, "echo:b", { timeZone: "Asia/Shanghai" });
    expect((b.payload as UserPayload).timeZone).toBe("Asia/Shanghai");
  });

  it("the org default time zone: PATCH validation and the fallback it gives", async () => {
    const url = `/api/v1/orgs/${orgId}/settings`;
    const bad = await owner({ method: "PATCH", url, payload: { timeZone: "Nowhere" } });
    expect(bad.statusCode).toBe(400);
    const ok = await owner({ method: "PATCH", url, payload: { timeZone: "Asia/Tokyo" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { settings: { timeZone?: string } }).settings.timeZone).toBe("Asia/Tokyo");
    const conv = await createConv(owner, orgId, agentId);
    const m = await send(conv, "echo:x");
    expect((m.payload as UserPayload).timeZone).toBe("Asia/Tokyo");
    await waitForTerminal(db, conv, 1, 30_000);
    // a stored value this runtime does not know reads as absent (lenient read)
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ timeZone: "Bad/Zone" }) })
      .where("id", "=", orgId)
      .execute();
    const got = (await owner({ method: "GET", url })).json() as { settings: { timeZone?: string } };
    expect(got.settings.timeZone).toBeUndefined();
    const cleared = await owner({ method: "PATCH", url, payload: { timeZone: null } });
    expect(cleared.statusCode).toBe(200);
  });
});

describe("run start", () => {
  it("writes the full snapshot once, then only changes: a rename, a later day, another zone", async () => {
    clockMs = Date.parse("2026-11-08T10:00:00Z");
    const conv = await createConv(owner, orgId, agentId);
    await send(conv, "echo:1", { timeZone: "Asia/Shanghai", locale: "zh" });
    await waitForTerminal(db, conv, 1, 30_000);
    const full = {
      agent: { name: "Grant", description: "Answers HR policy questions." },
      org: { name: "Acme" },
      date: "2026-11-08",
      timeZone: "Asia/Shanghai",
      locale: "zh",
      attribution: ATTRIBUTION,
    };
    expect(await contexts(conv)).toEqual([full]);
    // the model saw it after the first message, which carries the sender line
    const first = capture.sent[0];
    expect(first?.messages[0]?.content).toEqual([
      { type: "text", text: "From Wang Fang (owner)" },
      { type: "text", text: "echo:1" },
    ]);
    expect(first?.messages[1]?.role).toBe("system");
    expect(String(first?.messages[1]?.content)).toContain(
      '- You are "Grant", an agent in the org "Acme". Your description: Answers HR policy questions.',
    );

    // nothing changed: no new snapshot, and the same sender gets no line
    await send(conv, "echo:2", { timeZone: "Asia/Shanghai", locale: "zh" });
    await waitForTerminal(db, conv, 2, 30_000);
    expect(await contexts(conv)).toHaveLength(1);
    const second = capture.sent.at(-1);
    expect(second?.messages.at(-1)?.content).toEqual([{ type: "text", text: "echo:2" }]);

    // a rename (a new version) is noticed by the next run, not before
    const agent = (
      await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` })
    ).json() as { agent: { definition: Record<string, unknown> } };
    await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { definition: { ...agent.agent.definition, name: "Grant 2" } },
    });
    expect(await contexts(conv)).toHaveLength(1);
    await send(conv, "echo:3", { timeZone: "Asia/Shanghai", locale: "zh" });
    await waitForTerminal(db, conv, 3, 30_000);
    expect((await contexts(conv)).at(-1)).toEqual({
      agent: { name: "Grant 2", description: "Answers HR policy questions." },
    });
    expect(capture.sent.at(-1)?.messages.at(-1)).toEqual({
      role: "system",
      content:
        'Context update (replaces the earlier values):\n- Your name is now "Grant 2" (it was "Grant").',
    });

    // a clock behind across midnight writes nothing; the next day writes the date
    clockMs = Date.parse("2026-11-07T23:59:58Z") - 8 * 3600_000;
    await send(conv, "echo:4", { timeZone: "Asia/Shanghai", locale: "zh" });
    await waitForTerminal(db, conv, 4, 30_000);
    expect(await contexts(conv)).toHaveLength(2);
    clockMs = Date.parse("2026-11-09T01:00:00Z");
    await send(conv, "echo:5", { timeZone: "Asia/Shanghai", locale: "zh" });
    await waitForTerminal(db, conv, 5, 30_000);
    expect((await contexts(conv)).at(-1)).toEqual({ date: "2026-11-09" });

    // the person writes from another zone and language
    await send(conv, "echo:6", { timeZone: "America/New_York", locale: "en" });
    await waitForTerminal(db, conv, 6, 30_000);
    expect((await contexts(conv)).at(-1)).toEqual({
      timeZone: "America/New_York",
      date: "2026-11-08",
      locale: "en",
    });
  });

  it("racing and retried run starts append one event; a retry with its idem key writes nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await send(conv, "echo:1", { timeZone: "UTC", locale: "en" });
    await waitForTerminal(db, conv, 1, 30_000);
    const service = k.app.get(RunContextService);
    const agent = { name: "Racer", instructions: "" } as AgentDefinition;
    const input = { orgId, conversationId: conv, triggerSeq: 1, agent };
    const runId = randomUUID();
    await Promise.all([
      service.record({ ...input, runId }),
      service.record({ ...input, runId: randomUUID() }),
      service.record({ ...input, runId }),
    ]);
    const all = await contexts(conv);
    expect(all).toHaveLength(2);
    expect(all.at(-1)).toEqual({ agent: { name: "Racer" } });
    // either racer may have written it: retry with the run id of the event that was written
    const written = (await eventsOf(db, conv)).filter((e) => e.type === "run_context").at(-1);
    const winner = written?.runId ?? runId;
    await service.record({ ...input, runId: winner, agent: { ...agent, name: "Other" } });
    expect(await contexts(conv)).toHaveLength(2);
  });
});

describe("run start for a message that recorded no zone or language (older logs)", () => {
  /** A conversation whose only message is an older one: no `timeZone`, no `locale`. */
  async function oldConversation(): Promise<string> {
    const conv = await createConv(owner, orgId, agentId);
    await db
      .insertInto("conversation_events")
      .values({
        conversation_id: conv,
        seq: "1",
        type: "user_message",
        payload: JSON.stringify({
          content: [{ type: "text", text: "old" }],
          authorAccountId: ownerId,
        }),
      })
      .execute();
    await db.updateTable("conversations").set({ last_seq: "1" }).where("id", "=", conv).execute();
    return conv;
  }
  const record = (conv: string) =>
    k.app.get(RunContextService).record({
      orgId,
      conversationId: conv,
      runId: randomUUID(),
      triggerSeq: 1,
      agent: { name: "Grant", instructions: "" } as AgentDefinition,
    });

  it("falls back to the author's zone and latest web language, then the org's", async () => {
    const bare = await oldConversation();
    await record(bare);
    expect((await contexts(bare))[0]).toMatchObject({ timeZone: "UTC", locale: "en" });

    const prefs = await owner({
      method: "PUT",
      url: "/api/v1/me/preferences",
      payload: { timeZone: "Europe/Berlin" },
    });
    expect(prefs.statusCode, prefs.body).toBe(200);
    const web = await createConv(owner, orgId, agentId);
    await send(web, "echo:web", { timeZone: "Asia/Shanghai", locale: "zh" });
    const conv = await oldConversation();
    await record(conv);
    expect((await contexts(conv))[0]).toMatchObject({ timeZone: "Europe/Berlin", locale: "zh" });
  });
});

describe("CurrentTime reads the run context's zone and the run context clock", () => {
  const currentTime = async (conversationId: string, input: unknown = {}) => {
    const tool = k.app
      .get(BuiltinTools)
      .list()
      .find((t) => t.spec.name === "CurrentTime");
    if (tool === undefined) throw new Error("CurrentTime is not a builtin");
    const ctx = {
      orgId,
      conversationId,
      signal: new AbortController().signal,
    } as unknown as BuiltinCallContext;
    const r = (await tool.run(input, ctx)) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join("");
  };

  it("the latest run context zone; before any run the org default, else UTC", async () => {
    clockMs = Date.parse("2026-11-08T13:05:33Z");
    const conv = await createConv(owner, orgId, agentId);
    // no run context yet, no org default: UTC
    expect(await currentTime(conv)).toContain("Time zone: UTC (UTC+00:00)");
    const url = `/api/v1/orgs/${orgId}/settings`;
    await owner({ method: "PATCH", url, payload: { timeZone: "Asia/Tokyo" } });
    expect(await currentTime(conv)).toContain("Current time: 2026-11-08T22:05:33+09:00 (Sunday)");

    await send(conv, "echo:1", { timeZone: "Asia/Shanghai", locale: "zh" });
    await waitForTerminal(db, conv, 1, 30_000);
    expect(await currentTime(conv)).toBe(
      "Current time: 2026-11-08T21:05:33+08:00 (Sunday)\n" +
        "Time zone: Asia/Shanghai (UTC+08:00)\n" +
        "UTC: 2026-11-08T13:05:33Z",
    );
    await send(conv, "echo:2", { timeZone: "America/New_York", locale: "en" });
    await waitForTerminal(db, conv, 2, 30_000);
    expect(await currentTime(conv)).toContain("Time zone: America/New_York (UTC-05:00)");
    // an explicit zone wins
    expect(await currentTime(conv, { timeZone: "Europe/London" })).toContain(
      "Current time: 2026-11-08T13:05:33+00:00 (Sunday)",
    );
  });
});

describe("attribution at run start (spec 2026-11-14-agent-attribution)", () => {
  async function definition(): Promise<Record<string, unknown>> {
    const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    return (r.json() as { agent: { definition: Record<string, unknown> } }).agent.definition;
  }

  async function patch(change: (def: Record<string, unknown>) => Record<string, unknown>) {
    const r = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { definition: change(await definition()) },
    });
    expect(r.statusCode, r.body).toBe(200);
  }

  it("records the platform default, an agent's custom values with the link, then off", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await send(conv, "echo:1");
    await waitForTerminal(db, conv, 1, 30_000);
    expect((await contexts(conv))[0]).toMatchObject({ attribution: ATTRIBUTION });
    // an agent's custom values; sessionUrl on resolves the conversation link
    await patch((d) => ({
      ...d,
      attribution: { mode: "custom", commit: "Custom trailer", pr: "", sessionUrl: true },
    }));
    await send(conv, "echo:2");
    await waitForTerminal(db, conv, 2, 30_000);
    expect((await contexts(conv)).at(-1)).toEqual({
      attribution: { commit: "Custom trailer", pr: "", sessionUrl: `${PUBLIC_URL}/chat/${conv}` },
    });
    // the model saw the instruction from the logged context
    const systems = (capture.sent.at(-1)?.messages ?? []).filter((m) => m.role === "system");
    expect(systems.map((m) => String(m.content)).join("\n")).toContain(
      "end the commit message with this trailer: Custom trailer",
    );
    // off: nothing, and the update tells the model to stop
    await patch((d) => ({ ...d, attribution: { mode: "off" } }));
    await send(conv, "echo:3");
    await waitForTerminal(db, conv, 3, 30_000);
    expect((await contexts(conv)).at(-1)).toEqual({
      attribution: { commit: "", pr: "", sessionUrl: null },
    });
    expect(
      (capture.sent.at(-1)?.messages ?? []).map((m) => String(m.content)).join("\n"),
    ).toContain("Do not add an attribution line to git commits or pull requests.");
  });

  it("the admin console's default applies to an agent that follows the platform", async () => {
    await db
      .insertInto("deployment_settings")
      .values({
        key: "attribution",
        value: JSON.stringify({ commit: "DB trailer", pr: "DB pr line" }),
      })
      .onConflict((oc) =>
        oc
          .column("key")
          .doUpdateSet({ value: JSON.stringify({ commit: "DB trailer", pr: "DB pr line" }) }),
      )
      .execute();
    try {
      const conv = await createConv(owner, orgId, agentId);
      await send(conv, "echo:1");
      await waitForTerminal(db, conv, 1, 30_000);
      expect((await contexts(conv))[0]).toMatchObject({
        attribution: { commit: "DB trailer", pr: "DB pr line", sessionUrl: null },
      });
    } finally {
      await db.deleteFrom("deployment_settings").where("key", "=", "attribution").execute();
    }
  });
});
