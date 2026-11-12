import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/** `GET /orgs/:orgId/tools/extensions`: the enabled extensions' tools for the agent form. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] });
  k = await startKernel({
    ...base,
    extensions: [...base.extensions, fakeExtensionEntry("fake-tools-ui")],
  });
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let member: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  member = await session(k, "mem");
});

type Offer = {
  extensions: {
    plugin: string;
    displayName: { zh: string; en: string };
    tools: Record<string, unknown>[];
  }[];
};

const list = async (req: Req) => {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/tools/extensions` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Offer;
};

const toggle = async (enabled: boolean) => {
  const r = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/fake-tools-ui`,
    payload: { enabled },
  });
  expect(r.statusCode, r.body).toBe(200);
};

describe("extension tools over HTTP", () => {
  it("lists only the extensions enabled in the org, with each tool's metadata", async () => {
    const before = await list(member);
    expect(before.extensions.find((e) => e.plugin === "fake-tools-ui")).toBeUndefined();

    await toggle(true);
    const after = await list(member);
    const ext = after.extensions.find((e) => e.plugin === "fake-tools-ui");
    expect(ext).toEqual({
      plugin: "fake-tools-ui",
      displayName: { zh: "fake-tools-ui", en: "fake-tools-ui" },
      tools: [
        {
          name: "write",
          key: "plugin__fake-tools-ui__write",
          title: null,
          description:
            "Replace the item list of the current conversation. Send every item each time; " +
            "status is pending, in_progress or completed. Test fixture only.",
          annotations: {},
          defaultPolicy: "allow",
          switchedOff: false,
        },
        {
          name: "web-only",
          key: "plugin__fake-tools-ui__web-only",
          title: null,
          description:
            "Report who and where this call runs: the conversation source, its owner, the " +
            "caller and the caller's role. Offered only in web and direct-message " +
            "conversations. Test fixture only.",
          annotations: {},
          defaultPolicy: "allow",
          switchedOff: false,
        },
      ],
    });

    await toggle(false);
    const off = await list(owner);
    expect(off.extensions.find((e) => e.plugin === "fake-tools-ui")).toBeUndefined();
  });

  it("is an org route: a non-member gets 404 or 403", async () => {
    const accounts = accountsFor(db);
    await accounts.createLocal({ login: "out", password: PW, displayName: "X" });
    const out = await session(k, "out");
    const r = await out({ method: "GET", url: `/api/v1/orgs/${orgId}/tools/extensions` });
    expect([403, 404]).toContain(r.statusCode);
  });
});
