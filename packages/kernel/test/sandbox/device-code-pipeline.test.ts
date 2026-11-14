import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { deviceCodeIdemKey } from "../../src/tools/builtins/sandbox/device-code.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { AGENT, MODEL } from "../runtime/context/fixtures.js";

/**
 * The device-code card in the tool pipeline (auto mode spec §6, P-D13): `gh auth login --web`'s
 * recorded output becomes exactly one display-only `device_code` event, the event never contributes
 * to a model request, and the kernel-internal `loginCode` field never reaches the model. The device
 * is the fake sandbox (real /bin/sh in a temporary directory); the model is `model-fake`.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

/** Recorded `gh auth login --web` prompt (gh 2.63, GitHub.com, 2026-11-14), printed by the command. */
const GH_OUTPUT = [
  "! First copy your one-time code: 1A2B-C3D4",
  "- Press Enter to open https://github.com/login/device in your browser...",
];
const COMMAND = `printf '%s\\n' '${GH_OUTPUT[0]}' '${GH_OUTPUT[1]}'`;
/** The two prompt lines as plain strings (`GH_OUTPUT`'s elements are `string | undefined`). */
const [CODE_LINE, URL_PROMPT_LINE] = GH_OUTPUT as [string, string];

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let owner: Awaited<ReturnType<typeof session>>;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-device-code-"));
  // wrapped before the kernel starts: every provider request is recorded deep-copied
  capture.install();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin" as const, name: "Bash" }]),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

/** Runs one `Bash` call printing the recorded prompt; returns the conversation id. */
async function signIn(): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(
    owner,
    orgId,
    conv,
    `tool:Bash:${JSON.stringify({ command: COMMAND, description: "Sign in to GitHub" })}`,
  );
  await waitForTerminal(db, conv, 1, 30_000);
  return conv;
}

/** Launches `command` with `run_in_background` in a new conversation; returns the task id. */
async function launchBackground(command: string): Promise<{ conv: string; taskId: string }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(
    owner,
    orgId,
    conv,
    `tool:Bash:${JSON.stringify({ command, description: "Sign in", run_in_background: true })}`,
  );
  await waitForTerminal(db, conv, 1, 30_000);
  const launched = (await eventsOf(db, conv)).filter((e) => e.type === "tool_result").at(-1)
    ?.payload.content;
  const taskId = /Started background task (bt_[A-Za-z0-9_-]+)/.exec(launched ?? "")?.[1];
  expect(taskId, launched).toBeDefined();
  return { conv, taskId: taskId as string };
}

/**
 * The on-disk path of a task's output file: the fake sandbox writes
 * `<workspace>/.capybara/tasks/<id>.out`; the test waits on the file directly so the two reads land
 * where it wants them, with no timing guesses.
 */
async function outputFileOf(taskId: string): Promise<string | null> {
  for (const fsId of await readdir(join(root, "filesystems")).catch(() => [] as string[])) {
    const p = join(root, "filesystems", fsId, "workspace", ".capybara", "tasks", `${taskId}.out`);
    if (
      await readFile(p, "utf8").then(
        () => true,
        () => false,
      )
    )
      return p;
  }
  return null;
}

describe("the device code in the pipeline", { timeout: 120_000 }, () => {
  it("writes one display-only device_code event and no loginCode in the result", async () => {
    capture.reset();
    const conv = await signIn();
    const events = await eventsOf(db, conv);

    const codes = events.filter(
      (e): e is Extract<ConversationEvent, { type: "device_code" }> => e.type === "device_code",
    );
    expect(codes).toHaveLength(1);
    expect(codes[0]?.payload).toMatchObject({
      callId: expect.any(String) as unknown,
      url: "https://github.com/login/device",
      code: "1A2B-C3D4",
    });
    // the event sits before the call's result, so the card can hang under the command
    const resultAt = events.findIndex((e) => e.type === "tool_result");
    const codeAt = events.findIndex((e) => e.type === "device_code");
    expect(codeAt).toBeGreaterThan(-1);
    expect(codeAt).toBeLessThan(resultAt);

    const results = events.filter(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    const result = results.at(-1);
    expect(result?.payload.isError).toBe(false);
    // the model sees the command's stdout (which prints the code) but never the field
    expect(result?.payload.content).toContain("1A2B-C3D4");
    expect(result?.payload).not.toHaveProperty("loginCode");
    expect(JSON.stringify(result?.payload)).not.toContain("loginCode");
  });

  it("a background login shows its code when TaskOutput reads the task's output", async () => {
    capture.reset();
    const conv = await createConv(owner, orgId, agentId);
    // the natural flow: the login waits for the person, so it runs in the background and its
    // prompt is read while it waits (there is no streaming stage)
    const command = `printf '%s\\n' '${GH_OUTPUT[0]}' '${GH_OUTPUT[1]}'; sleep 20`;
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:Bash:${JSON.stringify({ command, description: "Sign in", run_in_background: true })}`,
    );
    await waitForTerminal(db, conv, 1, 30_000);
    const started = await eventsOf(db, conv);
    const launched = started.filter((e) => e.type === "tool_result").at(-1)?.payload.content;
    const taskId = /Started background task (bt_[A-Za-z0-9_-]+)/.exec(launched ?? "")?.[1];
    expect(taskId, launched).toBeDefined();
    // the launch only records the task: the prompt has not been read, so there is no card yet
    expect(started.filter((e) => e.type === "device_code")).toHaveLength(0);

    await postMessage(
      owner,
      orgId,
      conv,
      `tool:TaskOutput:${JSON.stringify({ task_id: taskId, block: true, timeout: 3000 })}`,
    );
    await waitForTerminal(db, conv, 2, 60_000);
    const events = await eventsOf(db, conv);
    const codes = events.filter(
      (e): e is Extract<ConversationEvent, { type: "device_code" }> => e.type === "device_code",
    );
    expect(codes).toHaveLength(1);
    const result = events.filter((e) => e.type === "tool_result").at(-1);
    expect(codes[0]?.payload.code).toBe("1A2B-C3D4");
    // the event names the call whose output carried it (the TaskOutput call), and the result
    // the model sees has the command's own output but never the kernel-internal field
    expect(codes[0]?.payload.callId).toBe(
      (result?.payload as { callId: string } | undefined)?.callId,
    );
    expect(result?.payload.content).toContain("1A2B-C3D4");
    expect(result?.payload).not.toHaveProperty("loginCode");
  });

  it("a prompt split across two TaskOutput reads still writes exactly one card", {
    timeout: 120_000,
  }, async () => {
    capture.reset();
    // gh prints the code line first and the URL line later; a long pause in between lets the first
    // read land between the two lines — the boundary a non-blocking read can land on (no shell
    // control structure: in auto mode that would need a command review)
    const command =
      `printf '%s\\n' '${GH_OUTPUT[0]}'; sleep 10; ` + `printf '%s\\n' '${GH_OUTPUT[1]}'; sleep 20`;
    const { conv, taskId } = await launchBackground(command);
    const file = await waitFor(
      async () => {
        const path = await outputFileOf(taskId);
        return path !== null && (await readFile(path, "utf8")).includes(CODE_LINE) ? path : null;
      },
      30_000,
      "the code line in the task output",
    );

    // read 1 sees the code line only: no complete prompt, no card
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:TaskOutput:${JSON.stringify({ task_id: taskId, block: false })}`,
    );
    await waitForTerminal(db, conv, 2, 30_000);
    expect((await eventsOf(db, conv)).filter((e) => e.type === "device_code")).toHaveLength(0);

    // wait for the URL line, then read again: the re-read tail carries the code line across the
    // read boundary, so the parser sees both halves (without it no read ever would)
    await waitFor(
      async () => (await readFile(file, "utf8")).includes(URL_PROMPT_LINE),
      30_000,
      "the URL line in the task output",
    );
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:TaskOutput:${JSON.stringify({ task_id: taskId, block: false })}`,
    );
    await waitForTerminal(db, conv, 3, 30_000);
    const codes = (await eventsOf(db, conv)).filter((e) => e.type === "device_code");
    expect(codes).toHaveLength(1);
    expect(codes[0]?.payload.code).toBe("1A2B-C3D4");
  });

  it("two reads of the whole prompt still write one card", { timeout: 120_000 }, async () => {
    capture.reset();
    const { conv, taskId } = await launchBackground(
      `printf '%s\\n' '${GH_OUTPUT[0]}' '${GH_OUTPUT[1]}'; sleep 20`,
    );
    await waitFor(
      async () => {
        const path = await outputFileOf(taskId);
        return path !== null && (await readFile(path, "utf8")).includes(URL_PROMPT_LINE);
      },
      30_000,
      "the whole prompt in the task output",
    );
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:TaskOutput:${JSON.stringify({ task_id: taskId, block: false })}`,
    );
    await waitForTerminal(db, conv, 2, 30_000);
    expect((await eventsOf(db, conv)).filter((e) => e.type === "device_code")).toHaveLength(1);

    // a second read has no new output; the per-code dedupe keeps the one card
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:TaskOutput:${JSON.stringify({ task_id: taskId, block: false })}`,
    );
    await waitForTerminal(db, conv, 3, 30_000);
    expect((await eventsOf(db, conv)).filter((e) => e.type === "device_code")).toHaveLength(1);
  });

  it("the append is idempotent: the same retry key writes nothing new", async () => {
    capture.reset();
    const conv = await signIn();
    const before = (await eventsOf(db, conv)).filter((e) => e.type === "device_code");
    expect(before).toHaveLength(1);
    const event = before[0] as Extract<ConversationEvent, { type: "device_code" }>;
    const runId = event.runId;
    if (runId === null) throw new Error("the device_code event has no run");

    // what a retry or a resumed run does: append the same event under the deterministic id again
    await k.app.get(EventLog).append(conv, [
      {
        type: "device_code",
        runId,
        idemKey: deviceCodeIdemKey(runId, event.payload.callId),
        payload: event.payload,
      },
    ]);
    const after = (await eventsOf(db, conv)).filter((e) => e.type === "device_code");
    expect(after).toHaveLength(1);
  });

  it("is never in a request: the request built with it equals the one built without it", async () => {
    capture.reset();
    const conv = await signIn();
    const events = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "device_code")).toBe(true);
    // the run made a second model call after the tool result, so the event existed when it was built
    expect(capture.sent.length).toBeGreaterThanOrEqual(2);

    const input = { agent: AGENT, agentVersion: 1, model: MODEL, step: 9 } as const;
    const withEvent = buildModelRequest({ events, ...input }).request;
    const withoutEvent = buildModelRequest({
      events: events.filter((e) => e.type !== "device_code"),
      ...input,
    }).request;
    expect(withEvent).toEqual(withoutEvent);
    // the display-only field and the event's fields never reach a provider request
    expect(JSON.stringify(withEvent)).not.toContain("loginCode");
    expect(JSON.stringify(capture.sent)).not.toContain("loginCode");
    expect(JSON.stringify(capture.sent)).not.toContain('"device_code"');
  });
});
