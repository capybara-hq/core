import type { InboxCtx, InboxPost } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { InboxItemsService } from "../../src/inbox/inbox-items.service.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { PUSH_QUEUE } from "../../src/push/jobs.js";
import { resolveRecipients } from "../../src/push/recipients.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Personal inbox items (collaboration spec §4.9): `ctx.inbox.post / resolve` of the
 * `fake-trigger-source` fixture (its probe carries its `ctx.inbox`), the kernel's own items, the
 * inbox list, the action click (the fixture's `requests` UI action, called as the clicking person)
 * and the dismissal. An item is its person's alone: another member and the org's owner get 404.
 * Push fanouts are owed through the outbox, kept pending (adds to the push queue fail) to be
 * counted; `fake-push` makes a push provider loaded.
 */

const PLUGIN = "fake-trigger-source";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let member: Req;
let ownerId: string;
let memberId: string;
let orgId: string;

type Probe = {
  inbox?: InboxCtx;
  actions?: { actionId: string; accountId: string; role: string; payload: unknown }[];
};
const probe = () => {
  const g = globalThis as { __fakeTriggerSource?: Probe };
  g.__fakeTriggerSource ??= {};
  return g.__fakeTriggerSource;
};
const inbox = (): InboxCtx => {
  const i = probe().inbox;
  if (!i) throw new Error("fake-trigger-source did not set up");
  return i;
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [fakeExtensionEntry(PLUGIN), fakeExtensionEntry("fake-push")],
        http: { port: 0, publicUrl: "https://capybara.example" },
      },
    ),
    {
      overrides: [
        { provide: OUTBOX_DISPATCH_FAILS, useValue: (queue: string) => queue === PUSH_QUEUE },
      ],
    },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.outbox");
  probe().actions = [];
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  member = await session(k, "mem");
  orgId = await createOrg(owner, "Acme");
  await db
    .insertInto("memberships")
    .values({ org_id: orgId, account_id: memberId, role: "member" })
    .execute();
  const on = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${PLUGIN}`,
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
});

const item = (over: Partial<InboxPost> = {}): InboxPost => ({
  orgId,
  accountId: memberId,
  kind: "item.assigned",
  title: "CAP-12 was assigned to you",
  body: "Export reports as PDF",
  link: `/p/${PLUGIN}/requests?key=CAP-12`,
  actions: [
    {
      id: "accept",
      label: { zh: "接受", en: "Accept" },
      style: "primary",
      uiAction: { contribution: "requests", actionId: "accept", payload: { key: "CAP-12" } },
    },
  ],
  ...over,
});

type Listed = { type: string; id: string; item?: Record<string, unknown> };
const listOf = async (req: Req): Promise<Listed[]> => {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Listed[] }).items.filter((i) => i.type === "item");
};

const click = (req: Req, id: string, actionId = "accept") =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/inbox/items/${id}/actions/${actionId}`,
    payload: { locale: "en" },
  });

const dismiss = (req: Req, id: string) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/inbox/items/${id}/dismiss` });

const stateOf = async (id: string) =>
  (
    await db
      .selectFrom("inbox_items")
      .select("state")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).state;

const fanouts = () =>
  db.selectFrom("outbox").selectAll().where("job_name", "=", "push-fanout").execute();

describe("ctx.inbox.post", () => {
  it("an item appears only in its person's inbox, without the UI actions it calls", async () => {
    const { itemId } = await inbox().post(item());
    const mine = await listOf(member);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      type: "item",
      id: itemId,
      item: {
        id: itemId,
        source: "plugin",
        plugin: PLUGIN,
        pluginName: { zh: PLUGIN, en: PLUGIN },
        kind: "item.assigned",
        title: "CAP-12 was assigned to you",
        body: "Export reports as PDF",
        link: `/p/${PLUGIN}/requests?key=CAP-12`,
        actions: [{ id: "accept", label: { zh: "接受", en: "Accept" }, style: "primary" }],
      },
    });
    expect(JSON.stringify(mine[0])).not.toContain("uiAction");
    // the org's owner (an admin) does not see another person's item
    expect(await listOf(owner)).toEqual([]);
  });

  it("refuses four actions, a link outside its own pages and a non-member", async () => {
    const four = ["a", "b", "c", "d"].map((id) => ({
      id,
      label: { zh: id, en: id },
      uiAction: { contribution: "requests", actionId: "accept" },
    }));
    await expect(inbox().post(item({ actions: four }))).rejects.toMatchObject({
      name: "InboxError",
      code: "invalid_item",
    });
    for (const link of [
      "/p/other-plugin/x",
      "/admin",
      "https://evil.example/p/fake-trigger-source/x",
    ]) {
      await expect(inbox().post(item({ link }))).rejects.toMatchObject({ code: "invalid_item" });
    }
    await expect(inbox().post(item({ accountId: "nobody" }))).rejects.toMatchObject({
      code: "invalid_item",
    });
    expect(await db.selectFrom("inbox_items").select("id").execute()).toEqual([]);
  });

  it("refuses an org where the plugin is not enabled", async () => {
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${PLUGIN}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    await expect(inbox().post(item())).rejects.toMatchObject({ code: "org_disabled" });
  });

  it("a dedupe key returns the open item instead of adding another", async () => {
    const a = await inbox().post(item({ dedupeKey: "assign-CAP-12" }));
    const b = await inbox().post(item({ dedupeKey: "assign-CAP-12", title: "Again" }));
    expect(b.itemId).toBe(a.itemId);
    expect(await listOf(member)).toHaveLength(1);
    // once resolved, the key posts a new item
    await inbox().resolve({ orgId, itemId: a.itemId });
    const c = await inbox().post(item({ dedupeKey: "assign-CAP-12" }));
    expect(c.itemId).not.toBe(a.itemId);
    expect((await fanouts()).map((r) => r.job_id).sort()).toEqual(
      [`push-fanout-inbox-${a.itemId}`, `push-fanout-inbox-${c.itemId}`].sort(),
    );
  });

  it("owes a push fanout whose recipients are the item's person, category inbox", async () => {
    const { itemId } = await inbox().post(item());
    const rows = await fanouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue: PUSH_QUEUE,
      job_id: `push-fanout-inbox-${itemId}`,
      data: { eventId: `inbox-${itemId}`, source: { kind: "inbox", itemId } },
      org_id: orgId,
    });
    expect(await resolveRecipients(db, { kind: "inbox", itemId })).toMatchObject({
      orgId,
      accountIds: [memberId],
      category: "inbox",
      path: `/inbox?org=${orgId}#item=${itemId}`,
      threadId: "inbox",
      title: { zh: PLUGIN, en: PLUGIN },
      conversationTitle: "CAP-12 was assigned to you",
      text: "inboxItem",
    });
    await dismiss(member, itemId);
    // a closed item pushes nothing
    expect(await resolveRecipients(db, { kind: "inbox", itemId })).toBeNull();
  });

  it("an expired item vanishes: not listed, not clickable, not dismissable", async () => {
    const { itemId } = await inbox().post(item({ expiresInSeconds: 60 }));
    await db
      .updateTable("inbox_items")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where("id", "=", itemId)
      .execute();
    expect(await listOf(member)).toEqual([]);
    expect((await click(member, itemId)).statusCode).toBe(404);
    expect((await dismiss(member, itemId)).statusCode).toBe(404);
    expect(probe().actions).toEqual([]);
  });

  it("resolve closes only this plugin's item", async () => {
    const { itemId } = await inbox().post(item());
    const kernelItem = await withOrgScope(orgId, () =>
      k.app
        .get(InboxItemsService)
        .post(
          { kind: "kernel" },
          { orgId, accountId: memberId, kind: "notice", title: "Kernel notice" },
        ),
    );
    await expect(inbox().resolve({ orgId, itemId: kernelItem.itemId })).rejects.toMatchObject({
      code: "not_found",
    });
    await inbox().resolve({ orgId, itemId });
    expect(await stateOf(itemId)).toBe("resolved");
    // resolving again is a no-op
    await inbox().resolve({ orgId, itemId });
    expect((await listOf(member)).map((i) => i.id)).toEqual([kernelItem.itemId]);
  });
});

describe("clicking an action", () => {
  it("calls the plugin's UI action as the clicking person, then resolves the item", async () => {
    const { itemId } = await inbox().post(item());
    const res = await click(member, itemId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ toast: { zh: "已接受", en: "Accepted" } });
    expect(probe().actions).toEqual([
      { actionId: "accept", accountId: memberId, role: "member", payload: { key: "CAP-12" } },
    ]);
    expect(await stateOf(itemId)).toBe("resolved");
    expect(await listOf(member)).toEqual([]);
    // a second click finds nothing open
    expect((await click(member, itemId)).statusCode).toBe(404);
    expect(probe().actions).toHaveLength(1);
  });

  it("another member and the org's owner cannot click or dismiss it (404)", async () => {
    const { itemId } = await inbox().post(item());
    for (const req of [owner]) {
      const r = await click(req, itemId);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ error: { code: "inbox.item_not_found" } });
      expect((await dismiss(req, itemId)).statusCode).toBe(404);
    }
    const other = await inbox().post(item({ accountId: ownerId }));
    expect((await click(member, other.itemId)).statusCode).toBe(404);
    expect((await dismiss(member, other.itemId)).statusCode).toBe(404);
    expect(probe().actions).toEqual([]);
    expect(await stateOf(itemId)).toBe("open");
    expect(await stateOf(other.itemId)).toBe("open");
  });

  it("an unknown action is 404 and a failing action leaves the item open", async () => {
    const { itemId } = await inbox().post(
      item({
        actions: [
          {
            id: "boom",
            label: { zh: "失败", en: "Fail" },
            uiAction: { contribution: "requests", actionId: "fail" },
          },
        ],
      }),
    );
    const unknown = await click(member, itemId, "nope");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "inbox.action_not_found" } });
    const failed = await click(member, itemId, "boom");
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(await stateOf(itemId)).toBe("open");
  });

  it("dismiss resolves without calling the plugin", async () => {
    const { itemId } = await inbox().post(item());
    const res = await dismiss(member, itemId);
    expect(res.statusCode, res.body).toBe(204);
    expect(await stateOf(itemId)).toBe("resolved");
    expect(probe().actions).toEqual([]);
  });
});

describe("kernel items", () => {
  const post = (over: Partial<InboxPost> = {}) =>
    withOrgScope(orgId, () =>
      k.app.get(InboxItemsService).post(
        { kind: "kernel" },
        {
          orgId,
          accountId: memberId,
          kind: "automation_depth_stopped",
          title: "Nightly triage",
          link: "/automations/a1",
          ...over,
        },
      ),
    );

  it("link to any in-app path, carry no actions and list with no plugin", async () => {
    const { itemId } = await post();
    expect((await listOf(member))[0]?.item).toMatchObject({
      id: itemId,
      source: "kernel",
      plugin: null,
      pluginName: null,
      link: "/automations/a1",
      actions: [],
    });
    expect(await resolveRecipients(db, { kind: "inbox", itemId })).toMatchObject({
      title: "Capybara",
    });
    await expect(post({ link: "//evil.example" })).rejects.toMatchObject({ code: "invalid_item" });
    await expect(
      post({
        actions: [
          {
            id: "a",
            label: { zh: "a", en: "a" },
            uiAction: { contribution: "requests", actionId: "accept" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_item" });
  });
});
