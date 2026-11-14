import {
  createDualReplicaHarness,
  type FakeChannelServer,
  fakeExtensionEntry,
  type Harness,
  startFakeChannelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, waitFor } from "../helpers/runs.js";
import { seedFakeImGuideItem } from "../helpers/setup-guides.js";

// Setup checks across two replicas (spec 2026-11-09-setup-guides-v2-design.md §10.7): the
// single-flight lock and the org's concurrency cap live in Redis, so two viewers on two replicas
// cause one third-party call, and an org runs at most 8 checks at once across replicas.

const FAKE_IM = fakeExtensionEntry("fake-im");

let im: FakeChannelServer;
let h: Harness;
let raw: ReturnType<typeof createDb>;
let cookie = "";
let base = "";
let agentId = "";
let itemId = "";

type Json = Record<string, unknown>;
type State = { status: string; reason?: { en: string }; checkedAt?: string };

const headers = (body: boolean) => ({
  "x-capybara-csrf": "1",
  ...(cookie !== "" && { cookie }),
  ...(body && { "content-type": "application/json" }),
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  replica?: number,
): Promise<{ status: number; json: Json; replica: number }> {
  const init: RequestInit = {
    method,
    headers: headers(body !== undefined),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  };
  const res =
    replica === undefined ? await h.request(path, init) : await h.requestTo(replica, path, init);
  const text = await res.text();
  if (path === "/api/v1/auth/login") {
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  return {
    status: res.status,
    json: (text === "" ? {} : JSON.parse(text)) as Json,
    replica: res.replica,
  };
}

beforeAll(async () => {
  im = await startFakeChannelServer();
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE, FAKE_IM],
    // no gateway: the connections hold no long connection
    roles: [
      ["api", "worker"],
      ["api", "worker"],
    ],
    extensionConfig: {
      "fake-im": { platformUrl: im.url, clientId: "c1", clientSecret: "client-secret-dual-1" },
    },
    config: { auth: { cookieSecure: false }, http: { publicUrl: "https://cap.example" } },
  });
  raw = createDb(h.dbUrl, 3);
  const db = kernelDb(raw);
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  expect((await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status).toBe(
    200,
  );
  const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
  expect(org.status).toBe(201);
  const orgId = (org.json.org as { id: string }).id;
  base = `/api/v1/orgs/${orgId}`;
  const en = await call("PUT", `${base}/extensions/fake-im`, {
    enabled: true,
    config: { url: im.book("acme").url },
  });
  expect(en.status, JSON.stringify(en.json)).toBe(200);
  const ag = await call("POST", `${base}/agents`, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: builtinsOff(),
    },
    visibility: "org",
  });
  expect(ag.status, JSON.stringify(ag.json)).toBe(201);
  agentId = (ag.json.agent as { id: string }).id;
  itemId = await seedFakeImGuideItem(db);
});

afterAll(async () => {
  im?.holdChecks(null);
  await raw?.destroy();
  await h?.stop();
  await im?.stop();
});

beforeEach(() => {
  im.checks.length = 0;
});

async function connection(n: number): Promise<string> {
  const ch = await call("POST", `${base}/channels`, {
    plugin: "fake-im",
    name: `Bot ${n}`,
    agentId,
    config: { platformUrl: im.url, appId: `cli_dual_${n}`, appSecret: `dual-secret-${n}-4b7c` },
  });
  expect(ch.status, JSON.stringify(ch.json)).toBe(201);
  return (ch.json.channel as { id: string }).id;
}

const runPath = (check: string) =>
  `${base}/catalog/${itemId}/guides/fake-im-app/checks/${check}/run`;
const statesPath = (connectionId: string) =>
  `${base}/catalog/${itemId}/guides/fake-im-app/checks?connectionId=${connectionId}`;

/** A held gate for `POST /checks`; `open()` lets every held answer through. */
function hold(): () => void {
  let open = () => {};
  im.holdChecks(
    new Promise<void>((r) => {
      open = r;
    }),
  );
  return () => {
    im.holdChecks(null);
    open();
  };
}

describe("setup checks across replicas", () => {
  it("single flight: two concurrent runs on replicas 0 and 1 make one third-party call", async () => {
    const id = await connection(1);
    const open = hold();
    try {
      const first = call("POST", runPath("proxy"), { connectionId: id }, 0);
      await waitFor(async () => im.checks.length === 1, 10_000, "the first run's call");
      const second = await call("POST", runPath("proxy"), { connectionId: id }, 1);
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      expect(second.replica).toBe(1);
      expect((second.json.result as State).status).toBe("running");
      // GET on the other replica sees the run in progress
      const during = await call("GET", statesPath(id), undefined, 1);
      expect((during.json.results as Record<string, State>).proxy?.status).toBe("running");
      open();
      const done = await first;
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.replica).toBe(0);
      const result = done.json.result as State;
      expect(result.status).toBe("ok");
      // the page re-reads GET and gets the result from either replica
      const after = await call("GET", statesPath(id), undefined, 1);
      expect((after.json.results as Record<string, State>).proxy).toMatchObject({
        status: "ok",
        checkedAt: result.checkedAt,
      });
    } finally {
      open();
    }
    expect(im.checks).toHaveLength(1);
    expect(im.checks[0]?.pid).toBe(h.replicas[0].pid);
  });

  it("org semaphore caps at 8 concurrent runs across replicas", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 9; n++) ids.push(await connection(100 + n));
    const open = hold();
    let running: Promise<{ status: number; json: Json; replica: number }>[] = [];
    try {
      // eight runs alternate between the replicas and are all held at the platform
      running = ids
        .slice(0, 8)
        .map((id, i) => call("POST", runPath("proxy"), { connectionId: id }, i % 2));
      await waitFor(async () => im.checks.length === 8, 15_000, "eight held runs");
      const ninth = await call("POST", runPath("proxy"), { connectionId: ids[8] }, 0);
      expect(ninth.status, JSON.stringify(ninth.json)).toBe(200);
      expect((ninth.json.result as State).status).toBe("running");
      expect(im.checks).toHaveLength(8);
      open();
      for (const r of await Promise.all(running)) {
        expect((r.json.result as State).status).toBe("ok");
      }
      // the slots are free again
      const later = await call("POST", runPath("proxy"), { connectionId: ids[8] }, 1);
      expect((later.json.result as State).status).toBe("ok");
      expect(im.checks).toHaveLength(9);
    } finally {
      open();
      await Promise.allSettled(running);
    }
  });
});
