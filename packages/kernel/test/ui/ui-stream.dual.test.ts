import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, waitForTerminal } from "../helpers/runs.js";
import { openSse, type SseClient, uiFrames } from "../helpers/sse.js";

/**
 * 界面刷新跨副本（双副本，独立进程，共享 PG / Redis）：
 * - 插件在副本 0 调 `ctx.ui.invalidate`，副本 1 上的对话 SSE 收到 `event: ui`，组织级 SSE 收到组织视图的刷新；
 * - todo：`todo__write` 之后取 `tasks` 视图，badge 为「已完成/总数」、主体是 checklist，对话 SSE 收到刷新。
 */

const UI_PROBE = fileURLToPath(new URL("../fixtures/plugins/ui-probe/index.ts", import.meta.url));
const TODO = fileURLToPath(new URL("../../../../plugins/todo/src/index.ts", import.meta.url));

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});
afterAll(async () => {
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("界面刷新（双副本）", () => {
  it("副本 0 invalidate → 副本 1 的对话 / 组织 SSE 收到 event: ui；todo 写入后 tasks 视图与刷新", async () => {
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, UI_PROBE, TODO],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);

    let cookie = "";
    const init = (method: string, body?: unknown, c = cookie): RequestInit => ({
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(c !== "" && { cookie: c }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const at = async (i: 0 | 1, method: string, path: string, body?: unknown, c = cookie) => {
      const res = await fetch(
        `http://127.0.0.1:${harness.replicas[i].port}${path}`,
        init(method, body, c),
      );
      expect(replicaOf(res)).toBe(i);
      const text = await res.text();
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };
    const loginAs = async (login: string): Promise<string> => {
      await new AccountsService(db).createLocal({ login, password: PW, displayName: login });
      const res = await harness.request(
        "/api/v1/auth/login",
        init("POST", { login, password: PW }, ""),
      );
      expect(res.status).toBe(200);
      await res.body?.cancel();
      return res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    };

    cookie = await loginAs("owner");
    const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    for (const plugin of ["ui-probe", "todo"]) {
      const en = await at(1, "PUT", `${base}/extensions/${plugin}`, { enabled: true });
      expect(en.status, JSON.stringify(en.json)).toBe(200);
    }
    const ag = await at(0, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "todo", name: "write" }],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    const conv = await at(1, "POST", `${base}/conversations`, { agentId });
    const convId = (conv.json.conversation as { id: string }).id;

    const sse = async (path: string, c = cookie): Promise<SseClient> => {
      const s = await openSse(`http://127.0.0.1:${harness.replicas[1].port}${path}`, {
        cookie: c,
      });
      cleanups.push(() => s.close());
      return s;
    };
    const convStream = await sse(`${base}/conversations/${convId}/stream`);
    expect(convStream.status).toBe(200);
    const orgStream = await sse(`${base}/ui/stream`);
    expect(orgStream.status).toBe(200);
    expect(orgStream.headers.get("content-type")).toMatch(/^text\/event-stream/);

    // ---- 副本 0 的插件 invalidate → 副本 1 的 SSE ----
    const inv = await at(0, "POST", "/plugins/ui-probe/invalidate", {
      orgId,
      conversationId: convId,
      contribution: "panel",
    });
    expect(inv.status).toBe(204);
    await convStream.until(
      (m) => uiFrames(m).some((f) => f.contribution === "panel"),
      10_000,
      "conversation ui frame",
    );
    expect(uiFrames(convStream.messages)).toEqual([{ plugin: "ui-probe", contribution: "panel" }]);

    const invOrg = await at(0, "POST", "/plugins/ui-probe/invalidate", {
      orgId,
      contribution: "orgpage",
    });
    expect(invOrg.status).toBe(204);
    await orgStream.until((m) => uiFrames(m).length > 0, 10_000, "org ui frame");
    expect(uiFrames(orgStream.messages)).toEqual([{ plugin: "ui-probe", contribution: "orgpage" }]);
    // 对话级刷新不进组织流
    expect(uiFrames(orgStream.messages).some((f) => f.contribution === "panel")).toBe(false);

    // ---- todo：写清单 → 对话 SSE 收到 tasks 刷新，tasks 视图 badge 与 checklist ----
    const empty = await at(0, "GET", `${base}/ui/views/todo/tasks?conversationId=${convId}`);
    expect(empty.status, JSON.stringify(empty.json)).toBe(200);
    expect(empty.json.view).toMatchObject({ badge: "0/0" });
    const todos = {
      todos: [
        { content: "Plan", status: "completed", activeForm: "Planning" },
        { content: "Build", status: "in_progress", activeForm: "Building" },
        { content: "Ship", status: "pending", activeForm: "Shipping" },
      ],
    };
    const sent = await at(0, "POST", `${base}/conversations/${convId}/messages`, {
      text: `tool:todo__write:${JSON.stringify(todos)}`,
    });
    expect(sent.status).toBe(202);
    await waitForTerminal(db, convId, 1, 30_000);
    await convStream.until(
      (m) => uiFrames(m).some((f) => f.plugin === "todo" && f.contribution === "tasks"),
      10_000,
      "todo tasks frame",
    );
    for (const i of [0, 1] as const) {
      const v = await at(
        i,
        "GET",
        `${base}/ui/views/todo/tasks?conversationId=${convId}&locale=zh`,
      );
      expect(v.status).toBe(200);
      expect(v.json.view).toEqual({
        badge: "1/3",
        blocks: [
          {
            type: "checklist",
            items: [
              { text: "Plan", status: "completed" },
              { text: "Building", status: "in_progress" },
              { text: "Ship", status: "pending" },
            ],
          },
        ],
      });
    }
    const contributions = await at(1, "GET", `${base}/ui/contributions`);
    expect(contributions.json.items).toContainEqual({
      plugin: "todo",
      id: "tasks",
      title: { zh: "任务", en: "Tasks" },
      place: "conversation",
      kind: "view",
    });

    // ---- 组织流：非成员 404、未登录 401 ----
    const strangerCookie = await loginAs("stranger");
    const denied = await at(1, "GET", `${base}/ui/stream`, undefined, strangerCookie);
    expect(denied.status).toBe(404);
    expect((denied.json.error as { code: string }).code).toBe("org.not_found");
    const anon = await fetch(`http://127.0.0.1:${harness.replicas[1].port}${base}/ui/stream`);
    expect(anon.status).toBe(401);
    await anon.body?.cancel();
  }, 120_000);
});
