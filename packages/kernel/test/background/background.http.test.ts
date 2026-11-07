import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchScript, newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "../../src/background/store.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { openSse } from "../helpers/sse.js";

/**
 * The background task routes (spec 2026-11-05-background-bash-design §5): listing, stopping and
 * reading the output of tasks, on one kernel with the fake sandbox. Tasks are started with the
 * launch script directly (as the `Bash` launch does), except in the SSE start test, where a
 * scripted run launches one.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

const RULES: ScriptRule[] = [
  {
    when: { lastUserIncludes: "SCENARIO start", assistantTurns: 0 },
    reply: {
      toolCalls: [
        {
          name: "Bash",
          input: { command: "sleep 331", description: "Sleep", run_in_background: true },
        },
      ],
    },
  },
  { when: { lastUserIncludes: "SCENARIO start", assistantTurns: 1 }, reply: { text: "started" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let sandbox: SandboxService;
let store: BackgroundTaskStore;
let job: BackgroundTaskPollJob;
let owner: Req;
let other: Req;
let ownerId: string;
let ownerCookie: () => string;
let orgId: string;
let agentId: string;
let used: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-bg-http-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fixture("model-script"), fixture("sandbox-fake")],
        extensionConfig: {
          "model-script": { rules: RULES },
          "sandbox-fake": { root },
        },
        sandbox: { background: { pollSeconds: 3600 } },
      },
    ),
  );
  sandbox = k.app.get(SandboxService);
  store = k.app.get(BackgroundTaskStore);
  job = k.app.get(BackgroundTaskPollJob);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  // the jar's cookie header is what the SSE client sends
  const jar = cookieJar();
  const loggedIn = asUser(k.http, jar);
  const login = await loggedIn({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  owner = loggedIn;
  ownerCookie = () => jar.header() as string;
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: [{ kind: "builtin", name: "Bash" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const e of new Set(used)) await sandbox.destroyEnvironment(e).catch(() => {});
  used = [];
  await sql`UPDATE capybara.background_tasks SET status = 'lost', finished_at = now()
    WHERE status = 'running'`.execute(raw);
});

const base = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/background-tasks`;

/** A new conversation of the owner (in the owner's default environment). */
async function conversation(): Promise<{
  orgId: string;
  conversationId: string;
  accountId: string;
  environmentId: string;
}> {
  const conversationId = await createConv(owner, orgId, agentId);
  const { environment_id } = await db
    .selectFrom("conversations")
    .select("environment_id")
    .where("id", "=", conversationId)
    .executeTakeFirstOrThrow();
  const environmentId = environment_id as string;
  used.push(environmentId);
  return { orgId, conversationId, accountId: ownerId, environmentId };
}

/** A sub-agent's conversation under `parent`, seeded in the database. */
async function child(parent: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id)
    VALUES (${id}, ${orgId}, ${agentId}, ${ownerId}, 'subagent', ${parent})`.execute(raw);
  return id;
}

/** Starts `command` as a background task of `owning`, in the environment of `c`, like `Bash` does. */
async function launch(
  c: { orgId: string; conversationId: string; accountId: string; environmentId: string },
  command: string,
  owning = c.conversationId,
  seconds = 300,
): Promise<BackgroundTaskRow> {
  const id = newTaskId();
  const startedAt = new Date();
  const r = await sandbox.withSandbox(
    {
      orgId: c.orgId,
      environmentId: c.environmentId,
      holderConversationId: c.conversationId,
      actor: { accountId: c.accountId, conversationId: c.conversationId },
    },
    (h, p, _info, sig) =>
      p.exec(h, {
        command: launchScript(id, command, seconds),
        cwd: "/workspace",
        timeoutMs: 20_000,
        maxOutputBytes: 64_000,
        signal: sig,
      }),
    AbortSignal.timeout(30_000),
  );
  expect(r.exitCode).toBe(0);
  const sid = r.stdout.trim();
  const { handle } = await db
    .selectFrom("environment_instances")
    .select("handle")
    .where("environment_id", "=", c.environmentId)
    .executeTakeFirstOrThrow();
  const record = join(root, "instances", (handle as { id: string }).id, "sessions", sid);
  await waitFor(async () => existsSync(record), 10_000, "session record");
  const instance = await sandbox.currentInstance(c.environmentId);
  await store.insert({
    id,
    orgId: c.orgId,
    conversationId: owning,
    sandboxConversationId: c.conversationId,
    environmentId: c.environmentId,
    runId: "run-x",
    callId: "call-x",
    triggerAccountId: c.accountId,
    description: `Run ${command}`.slice(0, 100),
    command,
    sid,
    outputPath: taskOutputPath(id),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + seconds * 1000),
    sandboxCreatedAt: instance?.createdAt as Date,
  });
  return (await store.get(id)) as BackgroundTaskRow;
}

interface View {
  id: string;
  conversationId: string;
  subagentId: string | null;
  status: string;
  stopping: boolean;
  description: string;
  command: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  lostReason: string | null;
}
const listOf = async (conv: string, as = owner) => {
  const r = await as({ method: "GET", url: base(conv) });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { tasks: View[] }).tasks;
};
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;

describe("background task routes", { timeout: 90_000 }, () => {
  it("lists the conversation's tasks newest first and its sub-agents' with subagentId", async () => {
    const c = await conversation();
    const kid = await child(c.conversationId);
    const own = await launch(c, "sleep 321");
    const sub = await launch(c, "sleep 322", kid);
    const tasks = await listOf(c.conversationId);
    expect(tasks.map((t) => t.id)).toEqual([sub.id, own.id]);
    expect(tasks[0]).toMatchObject({
      conversationId: c.conversationId,
      subagentId: kid,
      status: "running",
      stopping: false,
      command: "sleep 322",
      exitCode: null,
      lostReason: null,
      finishedAt: null,
    });
    expect(tasks[1]?.subagentId).toBeNull();
    expect(new Date(tasks[0]?.startedAt as string).getTime()).toBe(sub.startedAt.getTime());
    // the child's own page lists its task as its own
    const own2 = await listOf(kid);
    expect(own2.map((t) => [t.id, t.subagentId])).toEqual([[sub.id, null]]);
  });

  it("lists and stops a grandchild's task through the root and through its parent", async () => {
    const c = await conversation();
    const kid = await child(c.conversationId);
    const grandkid = await child(kid);
    const deep = await launch(c, "sleep 327", grandkid);
    const fromRoot = await listOf(c.conversationId);
    expect(fromRoot.map((t) => [t.id, t.subagentId])).toEqual([[deep.id, grandkid]]);
    const fromKid = await listOf(kid);
    expect(fromKid.map((t) => [t.id, t.subagentId])).toEqual([[deep.id, grandkid]]);
    // the grandchild's own page (depth 2) is reachable for the root's owner
    expect((await listOf(grandkid)).map((t) => [t.id, t.subagentId])).toEqual([[deep.id, null]]);
    expect((await other({ method: "GET", url: base(grandkid) })).statusCode).toBe(404);
    const r = await owner({ method: "POST", url: `${base(c.conversationId)}/${deep.id}/stop` });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { task: View }).task).toMatchObject({ id: deep.id, status: "stopped" });
  });

  it("hides a conversation from anyone who cannot see it (404), and needs a login", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 323");
    expect((await other({ method: "GET", url: base(c.conversationId) })).statusCode).toBe(404);
    const noOne = await k.http.inject({ method: "GET", url: base(c.conversationId) });
    expect(noOne.statusCode).toBe(401);
    for (const [method, url] of [
      ["GET", `${base(c.conversationId)}/${t.id}/output`],
      ["POST", `${base(c.conversationId)}/${t.id}/stop`],
    ] as const) {
      const r = await other({ method, url });
      expect([r.statusCode, code(r)]).toEqual([404, "conversation.not_found"]);
    }
    const bad = await owner({ method: "GET", url: base("not-a-uuid") });
    expect([bad.statusCode, code(bad)]).toEqual([404, "conversation.not_found"]);
  });

  it("answers 404 background_task.not_found for an unknown task and for another conversation's", async () => {
    const a = await conversation();
    const b = await conversation();
    const t = await launch(b, "sleep 324");
    for (const id of ["bt_aaaaaa", "nope", t.id]) {
      for (const [method, url] of [
        ["GET", `${base(a.conversationId)}/${id}/output`],
        ["POST", `${base(a.conversationId)}/${id}/stop`],
      ] as const) {
        const r = await owner({ method, url });
        expect([r.statusCode, code(r)]).toEqual([404, "background_task.not_found"]);
      }
    }
    expect((await store.get(t.id))?.status).toBe("running");
  });

  it("stops a task like a person (200, finished stopped, no wake), a sub-agent's too, and audits it", async () => {
    const c = await conversation();
    const kid = await child(c.conversationId);
    const t = await launch(c, "sleep 325", kid);
    const r = await owner({ method: "POST", url: `${base(c.conversationId)}/${t.id}/stop` });
    expect(r.statusCode, r.body).toBe(200);
    const { task } = r.json() as { task: View };
    expect(task).toMatchObject({
      id: t.id,
      subagentId: kid,
      status: "stopped",
      stopping: false,
    });
    expect(task.finishedAt).not.toBeNull();
    const events = await db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", kid)
      .where("type", "=", "background_task_finished")
      .execute();
    expect(events.map((e) => (e.payload as { stoppedBy?: string }).stoppedBy)).toEqual(["person"]);
    const audits = await sql<{ actor_account_id: string; org_id: string; detail: unknown }>`
      SELECT actor_account_id, org_id, detail FROM capybara.audit_events
      WHERE action = 'background_task.stopped' AND target = ${t.id}`.execute(raw);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      actor_account_id: ownerId,
      org_id: orgId,
      detail: { taskId: t.id, conversationId: kid, status: "stopped" },
    });
    // stopping a finished task returns it as it is
    const again = await owner({ method: "POST", url: `${base(c.conversationId)}/${t.id}/stop` });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { task: View }).task.status).toBe("stopped");
  });

  it("returns a task another stop already claimed as running and stopping (200, not an error)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 326");
    expect(await store.claimStop(t.id)).toBe(true);
    const r = await owner({ method: "POST", url: `${base(c.conversationId)}/${t.id}/stop` });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { task: View }).task).toMatchObject({ status: "running", stopping: true });
    expect((await listOf(c.conversationId))[0]?.stopping).toBe(true);
    await store.releaseStop(t.id);
  });

  it("reads the live end of the output; tail above 65536 or below 1 is a 400", async () => {
    const c = await conversation();
    const t = await launch(c, "printf 'one\\ntwo\\nthree\\n'; sleep 327");
    const out = (tail: string) =>
      owner({ method: "GET", url: `${base(c.conversationId)}/${t.id}/output${tail}` });
    await waitFor(
      async () => ((await out("")).json() as { text: string }).text === "one\ntwo\nthree\n",
      10_000,
      "the output",
    );
    expect((await out("")).json()).toEqual({
      text: "one\ntwo\nthree\n",
      truncated: false,
      source: "live",
    });
    expect((await out("?tail=6")).json()).toEqual({
      text: "three\n",
      truncated: true,
      source: "live",
    });
    for (const q of ["?tail=65537", "?tail=0", "?tail=-1", "?tail=x"]) {
      const r = await out(q);
      expect([r.statusCode, code(r)]).toEqual([400, "validation_failed"]);
    }
  });

  it("returns 64 KiB with truncated true for a 20 MB output", async () => {
    const c = await conversation();
    const t = await launch(c, "head -c 20000000 /dev/zero | tr '\\000' 'a'; echo END");
    await waitFor(
      async () => {
        const r = await owner({ method: "GET", url: `${base(c.conversationId)}/${t.id}/output` });
        return r.statusCode === 200 && (r.json() as { text: string }).text.endsWith("END\n");
      },
      30_000,
      "the 20 MB output",
      300,
    );
    const r = await owner({ method: "GET", url: `${base(c.conversationId)}/${t.id}/output` });
    const body = r.json() as { text: string; truncated: boolean; source: string };
    expect(Buffer.byteLength(body.text)).toBe(65_536);
    expect(body).toMatchObject({ truncated: true, source: "live" });
    expect(body.text.endsWith("aaaaEND\n")).toBe(true);
  });

  it("with the sandbox suspended answers a finished task from its event and a running one with 409", async () => {
    const c = await conversation();
    const c2 = await conversation();
    const done = await launch(c, "echo finished-line");
    const running = await launch(c2, "sleep 328");
    await waitFor(
      async () => {
        await job.pollOnce();
        return (await store.get(done.id))?.status === "completed";
      },
      15_000,
      "the finished task",
      200,
    );
    expect(await sandbox.suspendIdle(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    const ev = await owner({ method: "GET", url: `${base(c.conversationId)}/${done.id}/output` });
    expect(ev.statusCode, ev.body).toBe(200);
    expect(ev.json()).toEqual({ text: "finished-line\n", truncated: true, source: "event" });
    const no = await owner({
      method: "GET",
      url: `${base(c2.conversationId)}/${running.id}/output`,
    });
    expect([no.statusCode, code(no)]).toEqual([409, "background_task.output_unavailable"]);
    // reading never resumed the sandbox
    const row = await db
      .selectFrom("environment_instances")
      .select("status")
      .where("environment_id", "=", c.environmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("suspended");
  });

  it("sends changed: background when a task starts and when it finishes", async () => {
    const { conversationId: conv } = await conversation();
    const sse = await openSse(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { cookie: ownerCookie() },
    );
    const frames = (m: { event?: string; data?: unknown }[]) =>
      m.filter((x) => x.event === "changed" && x.data === '{"what":"background"}').length;
    try {
      await postMessage(owner, orgId, conv, "SCENARIO start");
      await waitForTerminal(db, conv, 1, 30_000);
      const [task] = await store.listFor([conv]);
      expect(task?.status).toBe("running");
      await sse.until((m) => frames(m) >= 1, 10_000, "changed: background on start");
      const before = frames(sse.messages);
      const r = await owner({ method: "POST", url: `${base(conv)}/${task?.id}/stop` });
      expect(r.statusCode, r.body).toBe(200);
      await sse.until((m) => frames(m) > before, 10_000, "changed: background on finish");
    } finally {
      sse.close();
    }
  });
});
