import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { TITLE_PROMPT } from "../../src/conversations/titles.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { devicePathsText } from "../../src/runtime/context/device-paths.js";
import { permissionContextText } from "../../src/runtime/context/permission-profile.js";
import { PermissionContextRecorder } from "../../src/runtime/permission-context.service.js";
import { PERMISSION_CONTEXT_RUN_ERRORS } from "../../src/runtime/permission-context-errors.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { ExecutionRevoked } from "../../src/runtime/run-execution.js";
import { livePermissionContext, RunSteps } from "../../src/runtime/run-steps.js";
import { PermissionConfigPublication } from "../../src/sandbox/permission-config-publication.js";
import {
  PERMISSION_CONTEXT_ACTIVATION,
  PERMISSION_CONTEXT_ACTIVE,
  permissionContextActive,
} from "../../src/sandbox/permission-context-types.js";
import { REVIEW_SYSTEM_PROMPT } from "../../src/sandbox/review/classifier.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  gate,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Gate 9.4: the live recorder at every actual agent request, through the production path
 * RunWorker → RunExecution.withClaim → RunSteps/LangGraphLoop → model-call, with the paired
 * activation gate provided on (production leaves it off: {@link PERMISSION_CONTEXT_ACTIVE}). The
 * provider requests are captured as sent; the first one can be held while it streams.
 */

const sent: ModelRequest[] = [];
/** When set, the next agent request waits for `release` after it was handed to the provider. */
let hold: { reached: () => void; release: Promise<void> } | null = null;
const originalResolve = ProviderRegistry.prototype.resolve;
function installCapture(): void {
  ProviderRegistry.prototype.resolve = async function (this: ProviderRegistry, orgId, ref) {
    const r = await originalResolve.call(this, orgId, ref);
    const inner = r.provider;
    return {
      ...r,
      provider: {
        ...(inner.embed && { embed: inner.embed }),
        async *stream(req, opts) {
          // agent-history requests only (no compaction, title, prompt suggestion, review or
          // extraction call)
          if (
            req.purpose !== "compaction" &&
            req.purpose !== "suggestion" &&
            !req.system.some(
              (s) => s.text === TITLE_PROMPT || s.text.startsWith(REVIEW_SYSTEM_PROMPT),
            )
          ) {
            sent.push(structuredClone(req));
            const h = hold;
            if (h) {
              hold = null;
              h.reached();
              await h.release;
            }
          }
          yield* inner.stream(req, opts);
        },
      },
    };
  };
}

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  installCapture();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }), {
    overrides: [{ provide: PERMISSION_CONTEXT_ACTIVATION, useValue: true }],
  });
});
afterAll(async () => {
  ProviderRegistry.prototype.resolve = originalResolve;
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" });
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("CurrentTime"),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  sent.length = 0;
  hold = null;
});

type Of<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = async <T extends ConversationEvent["type"]>(conv: string, type: T) =>
  (await eventsOf(db, conv)).filter((e) => e.type === type) as Of<T>[];
const occurrences = (req: ModelRequest | undefined, text: string): number =>
  JSON.stringify(req).split(JSON.stringify(text).slice(1, -1)).length - 1;

async function revision(conv: string): Promise<number> {
  const res = await owner({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/permissions`,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { revision?: number; permission?: { revision: number } };
  return body.revision ?? body.permission?.revision ?? 0;
}

describe("the paired activation gate", () => {
  it("is one explicit switch, on in production since the paired activation and off only where a test provides it", () => {
    expect(PERMISSION_CONTEXT_ACTIVE).toBe(true);
    expect(permissionContextActive(undefined)).toBe(true);
    expect(permissionContextActive(true)).toBe(true);
    expect(permissionContextActive(false)).toBe(false);
    // this kernel provides the gate: the live recorder is the step deps' request boundary
    expect(k.app.get(RunSteps).deps.permissionContext).toBeDefined();
    // the production value (no provider for the token) wires the boundary; an explicit off none
    const recorder = k.app.get(PermissionContextRecorder);
    expect(livePermissionContext(recorder, undefined).permissionContext).toBeDefined();
    expect(livePermissionContext(recorder, true).permissionContext).toBeDefined();
    expect(livePermissionContext(recorder, false)).toEqual({});
  });
});

describe("recorded permission context at actual agent requests", () => {
  it("records before the first request, which carries it and locates it in its metadata", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:hello");
    const [end] = await waitForTerminal(db, conv);
    expect(end?.type).toBe("run_finished");
    const [context] = await ofType(conv, "permission_context");
    const [call] = await ofType(conv, "model_call");
    expect(context?.payload).toMatchObject({
      rootConversationId: conv,
      // a new conversation's stored default
      selectedProfile: "approve-for-me",
      inherited: false,
      availability: { state: "unavailable", cause: "no-device" },
    });
    expect(context?.seq ?? 0).toBeLessThan(call?.seq ?? 0);
    expect(call?.payload.request.permissionContext?.contextSeq).toBe(context?.seq);
    expect(sent).toHaveLength(1);
    expect(occurrences(sent[0], permissionContextText(context?.payload as never))).toBe(1);
  });

  it("a profile change while request A streams leaves A's request unchanged; request B appends the new context", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const reached = gate();
    const release = gate();
    hold = { reached: reached.open, release: release.promise };
    await postMessage(owner, orgId, conv, "tool:CurrentTime:{}");
    await reached.promise;
    const [callA] = await ofType(conv, "model_call");
    const requestA = structuredClone(sent[0]);
    // the person changes the root's profile through the API while A is still streaming
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/permissions`,
      payload: { profile: "request-approval", expectedRevision: await revision(conv) },
    });
    expect(res.statusCode, res.body).toBe(200);
    release.open();
    const [end] = await waitForTerminal(db, conv);
    expect(end?.type).toBe("run_finished");
    const calls = await ofType(conv, "model_call");
    const contexts = await ofType(conv, "permission_context");
    expect(calls).toHaveLength(2);
    // A's stored request and the bytes it was sent with did not change
    expect(calls[0]?.payload).toEqual(callA?.payload);
    expect(sent[0]).toEqual(requestA);
    expect(contexts.map((c) => c.payload.selectedProfile)).toEqual([
      "approve-for-me",
      "request-approval",
    ]);
    const [result] = await ofType(conv, "tool_result");
    expect(contexts[1]?.seq ?? 0).toBeGreaterThan(result?.seq ?? 0);
    expect(contexts[1]?.seq ?? 0).toBeLessThan(calls[1]?.seq ?? 0);
    expect(calls[0]?.payload.request.permissionContext?.contextSeq).toBe(contexts[0]?.seq);
    expect(calls[1]?.payload.request.permissionContext?.contextSeq).toBe(contexts[1]?.seq);
    // append-only: B repeats A's history and appends the new snapshot after the tool result
    const text = permissionContextText(contexts[0]?.payload as never);
    expect(occurrences(sent[0], text)).toBe(1);
    expect(occurrences(sent[1], text)).toBe(2);
    expect(sent[1]?.messages.slice(0, 1)).toEqual(sent[0]?.messages.slice(0, 1));
  });

  it("an old-mode device line in the prefix stays and the appended v1 context supersedes it", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const legacy = {
      roots: { workspace: "/home/user/work", skills: "/home/user/.skills", tmp: "/tmp" },
      mode: "auto" as const,
      allowedMode: "auto" as const,
      network: { kind: "allowlist" as const, hosts: ["example.com"] },
      local: true,
    };
    await k.app.get(EventLog).append(conv, [{ type: "device_paths", payload: legacy as never }]);
    await postMessage(owner, orgId, conv, "echo:hello");
    await waitForTerminal(db, conv);
    const [context] = await ofType(conv, "permission_context");
    const body = JSON.stringify(sent[0]);
    const old = JSON.stringify(devicePathsText(legacy as never)).slice(1, -1);
    const current = JSON.stringify(permissionContextText(context?.payload as never)).slice(1, -1);
    expect(body.indexOf(old)).toBeGreaterThanOrEqual(0);
    expect(body.indexOf(current)).toBeGreaterThan(body.indexOf(old));
    expect(current).toContain("supersedes earlier device-mode descriptions");
  });

  it("a revoked execution reaches the worker unchanged: no request, no stale terminal event", async () => {
    const recorder = k.app.get(PermissionContextRecorder);
    const real = recorder.record.bind(recorder);
    let revoked = 0;
    const spy = vi.spyOn(recorder, "record").mockImplementation(async (input, signal) => {
      if (revoked++ === 0) throw new ExecutionRevoked();
      return real(input, signal);
    });
    try {
      const conv = await createConv(owner, orgId, agentId);
      await postMessage(owner, orgId, conv, "echo:hello");
      // the interrupted execution is picked up again and finishes normally
      const [end] = await waitForTerminal(db, conv);
      expect(end?.type).toBe("run_finished");
      expect(revoked).toBeGreaterThanOrEqual(2);
      expect(await ofType(conv, "run_failed")).toEqual([]);
      // the revoked attempt sent nothing: one request, one model_call
      expect(sent).toHaveLength(1);
      expect(await ofType(conv, "model_call")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a stale publication fails the run with its named error before any request", async () => {
    const spy = vi
      .spyOn(k.app.get(PermissionConfigPublication), "assertCurrent")
      .mockRejectedValue(new SandboxScopeDeniedError("not applied here"));
    try {
      const conv = await createConv(owner, orgId, agentId);
      await postMessage(owner, orgId, conv, "echo:hello");
      const [end] = await waitForTerminal(db, conv);
      expect(end?.type).toBe("run_failed");
      expect((end as Of<"run_failed">).payload.error).toEqual(PERMISSION_CONTEXT_RUN_ERRORS.stale);
      expect(sent).toEqual([]);
      expect(await ofType(conv, "model_call")).toEqual([]);
      expect(await ofType(conv, "permission_context")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
