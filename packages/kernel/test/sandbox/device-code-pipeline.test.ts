import { mkdtemp, rm } from "node:fs/promises";
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
