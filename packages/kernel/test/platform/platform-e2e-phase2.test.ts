import { defineExtension, secret, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { INITIAL_PASSWORD_NOTE } from "../../src/platform/ops/accounts.ops.js";
import { importPlugin, type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import {
  createConv,
  eventsOf,
  postMessage,
  type Req,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * The `Platform` tool end to end, phase 2 (Platform tool spec §14): model-fake scripts the calls,
 * the real pipeline decides (precheck before the card, role-keyed next steps, remember rules) and
 * the real operations run. Phase 1's cases are in platform-e2e.test.ts.
 *
 * The three sync failures are red in the checks suite, not here: an operation whose input drifts
 * from its route's schema (tools/checks/test/platform-parity.test.ts, fixtures/platform-parity/
 * cases.ts), a route neither mirrored nor excluded (tools/checks/test/platform-ops.test.ts,
 * platform-op-missing) and a removed route whose operation or exclusion stayed behind
 * (platform-parity.test.ts `orphan/`, platform-op-orphan).
 */

const NAME = "keyed-ai";
const ADMIN_PATH = `admin console → Extensions → ${NAME} → fill in the deployment config`;

let env: OrgEnv;
/** The super admin's private agent (admin-console operations run only through it). */
let privateAgent: string;
/** An agent visible to the whole org, for the org admin and the member. */
let orgAgent: string;
let itemId: string;

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);
const call = (operation: string, params: Record<string, unknown> = {}) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation, params })}`;
const lastResult = (evs: ConversationEvent[]) =>
  ofType(evs, "tool_result").at(-1)?.payload as Ev<"tool_result">["payload"];

async function agent(name: string, visibility: "org" | "private"): Promise<string> {
  const res = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Platform"),
      },
      visibility,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** A conversation as `who`; `turn` posts and waits for the run to end, `ask` for an approval. */
async function conversation(who: Req, agentId: string) {
  const id = await createConv(who, env.orgId, agentId);
  let terminals = 0;
  return {
    id,
    async turn(text: string) {
      await postMessage(who, env.orgId, id, text);
      await waitForTerminal(env.db, id, ++terminals, 30_000);
      return eventsOf(env.db, id);
    },
    async ask(text: string) {
      const before = ofType(await eventsOf(env.db, id), "approval_requested").length;
      await postMessage(who, env.orgId, id, text);
      return waitFor(
        async () => ofType(await eventsOf(env.db, id), "approval_requested")[before],
        20_000,
        "approval_requested",
      );
    },
    async finish() {
      await waitForTerminal(env.db, id, ++terminals, 30_000);
      return eventsOf(env.db, id);
    },
  };
}

const approvalOf = async (who: Req, id: string) => {
  const res = await who({ method: "GET", url: `/api/v1/orgs/${env.orgId}/approvals/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { approval: Record<string, unknown> }).approval;
};
const decide = (who: Req, id: string, body: Record<string, unknown>) =>
  who({ method: "POST", url: `/api/v1/orgs/${env.orgId}/approvals/${id}/decision`, payload: body });

/** An extension installed on the platform whose deployment API key is missing (spec §14.2). */
async function importKeyedExtension(): Promise<string> {
  const config = { deployment: z.object({ apiKey: secret(z.string().min(1)) }) };
  const real = defineExtension({
    name: NAME,
    version: "1.0.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    permissions: {},
    config,
    setup() {},
  });
  const entry = [
    'import { defineExtension, secret } from "@capybara-hq/plugin-sdk";',
    'import { z } from "zod";',
    `export default defineExtension({ name: ${JSON.stringify(NAME)}, version: "1.0.0", sdk: "^0.1.0-rc.0", provides: [], permissions: {}, config: { deployment: z.object({ apiKey: secret(z.string().min(1)) }) }, setup() {} });`,
  ].join("\n");
  const bytes = await pluginTgz({
    manifest: { name: NAME },
    extension: { manifest: { ...staticManifestOf(real) }, entry },
  });
  const id = await importPlugin(env, bytes);
  await waitFor(
    async () =>
      (
        await env.db
          .selectFrom("extension_replica_status")
          .select("reason")
          .where("plugin", "=", NAME)
          .executeTakeFirst()
      )?.reason === "config",
    15_000,
    "pending config",
  );
  return id;
}

beforeAll(async () => {
  env = await startOrgEnv();
  privateAgent = await agent("Mine", "private");
  orgAgent = await agent("Helper", "org");
  itemId = await importKeyedExtension();
});

afterAll(async () => {
  await env?.stop();
});

describe("Platform tool end to end, phase 2", () => {
  describe("(a) an installed extension missing its deployment config: one call, no card", () => {
    it("the super admin is told the admin console path", async () => {
      const conv = await conversation(env.root, privateAgent);
      const evs = await conv.turn(call("plugins.set-enabled", { itemId, enabled: true }));
      expect(ofType(evs, "approval_requested")).toEqual([]);
      const r = lastResult(evs);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("needs_deployment_config");
      expect(r.content).toContain(ADMIN_PATH);
    });

    it("the org admin is sent to the super admin, without the admin console path or a field", async () => {
      const conv = await conversation(env.boss, orgAgent);
      const evs = await conv.turn(call("plugins.set-enabled", { itemId, enabled: true }));
      expect(ofType(evs, "approval_requested")).toEqual([]);
      const r = lastResult(evs);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("needs_deployment_config");
      expect(r.content).toContain("super admin");
      expect(r.content).not.toContain("admin console");
      expect(r.content).not.toContain("apiKey");
    });

    it("a member reads why and asks an org admin", async () => {
      const conv = await conversation(env.mem, orgAgent);
      const evs = await conv.turn(call("plugins.get", { itemId }));
      expect(ofType(evs, "approval_requested")).toEqual([]);
      const r = lastResult(evs);
      expect(r.isError).toBe(false);
      const out = JSON.parse(r.content) as {
        item: { state: string; reason: string; next: string };
      };
      expect(out.item).toMatchObject({ state: "unavailable", reason: "needs_deployment_config" });
      expect(out.item.next).toContain("org admin");
      expect(r.content).not.toContain("admin console");
      expect(r.content).not.toContain("apiKey");
    });
  });

  it("(b) the super admin creates a user: no password in the result, the approver reads it once", async () => {
    const conv = await conversation(env.root, privateAgent);
    const asked = await conv.ask(call("accounts.create", { login: "dana", displayName: "Dana" }));
    const approvalId = asked.payload.approvalId;
    expect(
      await decide(env.root, approvalId, { decision: "approve", scope: "once" }),
    ).toMatchObject({ statusCode: 200 });
    const evs = await conv.finish();
    const r = lastResult(evs);
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content) as { initialPassword: string };
    expect(out.initialPassword).toBe(INITIAL_PASSWORD_NOTE);
    const reveal = () =>
      env.root({
        method: "POST",
        url: `/api/v1/orgs/${env.orgId}/approvals/${approvalId}/initial-password`,
      });
    const shown = await reveal();
    expect(shown.statusCode, shown.body).toBe(200);
    const { password } = shown.json() as { password: string };
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(JSON.stringify(evs)).not.toContain(password);
    expect((await reveal()).statusCode).toBe(404);
  });

  it("(c) a member reads, in another conversation, the call waiting for their approval", async () => {
    const victim = await createConv(env.mem, env.orgId, orgAgent);
    const conv = await conversation(env.mem, orgAgent);
    const asked = await conv.ask(call("conversations.delete", { conversationId: victim }));

    const reader = await conversation(env.mem, orgAgent);
    const evs = await reader.turn(call("approvals.waiting"));
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const waiting = JSON.parse(lastResult(evs).content) as {
      items: { id: string; name: string; state: string; next?: string }[];
    };
    expect(waiting.items).toContainEqual(
      expect.objectContaining({
        id: asked.payload.approvalId,
        name: "Platform:conversations.delete",
        state: "pending",
      }),
    );
    // the summary the inbox shows, never the call's input
    expect(lastResult(evs).content).not.toMatch(/"(input|params)"/);

    await decide(env.mem, asked.payload.approvalId, { decision: "deny" });
    expect(lastResult(await conv.finish()).isError).toBe(true);
  });

  it("(d) a member's delete asks every time, once only", async () => {
    const victim1 = await createConv(env.mem, env.orgId, orgAgent);
    const victim2 = await createConv(env.mem, env.orgId, orgAgent);
    const conv = await conversation(env.mem, orgAgent);

    const first = await conv.ask(call("conversations.delete", { conversationId: victim1 }));
    expect(first.payload.toolKey).toBe("Platform:conversations.delete");
    // personal, but destructive: never remembered
    expect((await approvalOf(env.mem, first.payload.approvalId)).scopes).toEqual(["once"]);
    expect(
      await decide(env.mem, first.payload.approvalId, { decision: "approve", scope: "once" }),
    ).toMatchObject({ statusCode: 200 });
    expect(lastResult(await conv.finish()).isError).toBe(false);
    const gone = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/conversations/${victim1}`,
    });
    expect(gone.statusCode).toBe(404);

    // the next delete asks again, still once only
    const second = await conv.ask(call("conversations.delete", { conversationId: victim2 }));
    expect(second.payload.approvalId).not.toBe(first.payload.approvalId);
    expect((await approvalOf(env.mem, second.payload.approvalId)).scopes).toEqual(["once"]);
    await decide(env.mem, second.payload.approvalId, { decision: "deny" });
    expect(lastResult(await conv.finish()).isError).toBe(true);
  });

  it("(e) a profile change may be remembered on an own private agent, never on a shared one", async () => {
    const conv = await conversation(env.root, privateAgent);
    const mine = await conv.ask(
      call("agents.update-profile", {
        agentId: privateAgent,
        avatar: { kind: "preset", id: "whale" },
      }),
    );
    expect(mine.payload.toolKey).toBe("Platform:agents.update-profile");
    const mineView = await approvalOf(env.root, mine.payload.approvalId);
    expect(mineView.scopes).toEqual(["once", "session", "always"]);
    expect(mineView.summary).toEqual({
      zh: "修改私有智能体「Mine」的资料：头像设为预设「whale」",
      en: 'Update the profile of private agent "Mine": set the avatar to preset "whale"',
    });
    await decide(env.root, mine.payload.approvalId, { decision: "approve", scope: "once" });
    expect(lastResult(await conv.finish()).isError).toBe(false);
    const got = await env.root({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/agents/${privateAgent}`,
    });
    expect(
      (got.json() as { agent: { profile: { avatar: unknown } } }).agent.profile.avatar,
    ).toEqual({ kind: "preset", id: "whale" });

    // the org's agent (the same owner): asked every time, once only
    const shared = await conv.ask(
      call("agents.update-profile", { agentId: orgAgent, quickActions: [] }),
    );
    expect((await approvalOf(env.root, shared.payload.approvalId)).scopes).toEqual(["once"]);
    await decide(env.root, shared.payload.approvalId, { decision: "deny" });
    expect(lastResult(await conv.finish()).isError).toBe(true);
  });
});
