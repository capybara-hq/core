import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { AgentDefinitionSchema } from "../../src/agents/definition.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type CaseSnapshot, replayableCalls, takeSnapshot } from "../../src/evals/snapshot.js";
import { replayStep, resolveCandidate, type StepReplayDeps } from "../../src/evals/step-replay.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import type { MediaSourceDeps } from "../../src/runtime/model-call.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * 单步回放（T4，D2 / C5）：基线取快照里该步的回复与用量；候选请求由 `reconstructRequest` 还原，
 * 用 `consumeModelStream` 收完。候选等于基线时内容相等；换模型发到另一个供应商；改指令时 system 含新指令；
 * 媒体按快照自己的 orgId / conversationId 取（C3）。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let owner: Req;
let orgId: string;
let snap: CaseSnapshot;
let def: AgentDefinition;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MODEL_EVAL] }),
  );
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "o" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const agentId = await createAgent(owner, orgId);
  const convId = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, convId, "echo:the answer is 42");
  await waitForTerminal(db, convId);
  const run = await db
    .selectFrom("runs")
    .select("id")
    .where("conversation_id", "=", convId)
    .executeTakeFirstOrThrow();
  snap = await takeSnapshot(db, orgId, convId, run.id, 4_000_000);
  def = snap.definitions[String(snap.agentVersion)] as AgentDefinition;
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(() => resetEvalModel());

const deps = (media?: MediaSourceDeps): StepReplayDeps => ({
  registry: k.runs.registry,
  config: () => k.config,
  ...(media !== undefined && { media }),
});

const firstCall = () => {
  const c = replayableCalls(snap)[0];
  if (!c) throw new Error("no replayable call");
  return c;
};

const base = () => ({ definition: def, agentVersion: snap.agentVersion });

describe("resolveCandidate", () => {
  it("an empty candidate is the baseline", () => {
    const r = resolveCandidate(base(), {});
    expect(r.changed).toBe(false);
    expect(r.model).toEqual(def.model);
    expect(r.agentVersion).toBe(snap.agentVersion);
    expect(r.definition.instructions).toBe(def.instructions);
  });

  it("instructions, model, params and agent version override the base", () => {
    const i = resolveCandidate(base(), { instructions: "Answer in French." });
    expect(i.changed).toBe(true);
    expect(i.definition.instructions).toBe("Answer in French.");

    const m = resolveCandidate(base(), { model: { provider: "model-eval", model: "eval-1" } });
    expect(m.changed).toBe(true);
    expect(m.model).toEqual({ provider: "model-eval", model: "eval-1" });
    // 换了模型而没给参数：原定义的参数属于原模型，不带过去
    expect(m.params).toEqual({});

    const p = resolveCandidate(base(), { modelParams: { effort: "low" } });
    expect(p.changed).toBe(true);
    expect(p.params).toEqual({ effort: "low" });

    const v2 = AgentDefinitionSchema.parse({
      name: "Helper v2",
      instructions: "Version two.",
      model: { provider: "model-eval", model: "eval-2" },
    });
    const v = resolveCandidate(base(), { agentVersion: 2 }, v2);
    expect(v.changed).toBe(true);
    expect(v.agentVersion).toBe(2);
    expect(v.definition.instructions).toBe("Version two.");
    expect(v.model).toEqual({ provider: "model-eval", model: "eval-2" });

    // 给的值与原值相同：仍是基线
    expect(
      resolveCandidate(base(), { instructions: def.instructions, model: def.model }).changed,
    ).toBe(false);
  });
});

describe("replayStep", () => {
  it("a candidate equal to the baseline reproduces the recorded reply", async () => {
    const call = firstCall();
    const out = await replayStep(
      deps(),
      snap,
      call,
      resolveCandidate(base(), {}),
      new AbortController().signal,
    );
    expect(out.drift).toEqual([]);
    expect(out.baseline.content).toEqual([{ type: "text", text: "the answer is 42" }]);
    expect(out.baseline.stopReason).toBe("end_turn");
    expect(out.baseline.usage).not.toBeNull();
    expect(out.candidate.content).toEqual(out.baseline.content);
    expect(out.candidate.stopReason).toBe(out.baseline.stopReason);
    expect(out.candidate.provider).toBe("model-fake");
    expect(out.candidate.model).toBe("fake-1");
    expect(out.candidate.latencyMs).toBeGreaterThanOrEqual(0);
    expect(evalModelState().requests).toHaveLength(0);
  });

  it("swapping the model sends the request to the other provider", async () => {
    const out = await replayStep(
      deps(),
      snap,
      firstCall(),
      resolveCandidate(base(), { model: { provider: "model-eval", model: "eval-1" } }),
      new AbortController().signal,
    );
    const reqs = evalModelState().requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.model).toBe("eval-1");
    // 参数按候选模型的声明补默认值
    expect(reqs[0]?.params).toEqual({ "model-eval.level": 1 });
    expect(out.candidate.provider).toBe("model-eval");
    expect(out.candidate.content).toEqual([{ type: "text", text: "reply from eval-1" }]);
    expect(out.candidate.usage.inputTokens).toBe(100);
    expect(out.baseline.content).toEqual([{ type: "text", text: "the answer is 42" }]);
  });

  it("changed instructions reach the system prompt", async () => {
    await replayStep(
      deps(),
      snap,
      firstCall(),
      resolveCandidate(base(), {
        model: { provider: "model-eval", model: "eval-1" },
        instructions: "Always answer in French.",
      }),
      new AbortController().signal,
    );
    const system =
      evalModelState()
        .requests[0]?.system.map((s) => s.text)
        .join("\n") ?? "";
    expect(system).toContain("Always answer in French.");
    expect(system).not.toContain("Be helpful.");
  });

  it("loads media from the snapshot's own org and conversation", async () => {
    const attachmentId = "0b9f5a52-2a7e-4a4c-9d61-5d0c6f0b1a11";
    const withImage: CaseSnapshot = structuredClone(snap);
    const user = withImage.events.find((e) => e.type === "user_message");
    if (!user) throw new Error("no user message");
    (user.payload as { content: unknown[] }).content.push({
      type: "image",
      mediaType: "image/png",
      source: { kind: "ref", attachmentId },
    });
    const calls: { fn: string; orgId: string; conversationId: string; ids: readonly string[] }[] =
      [];
    const media: MediaSourceDeps = {
      async info(o, c, ids) {
        calls.push({ fn: "info", orgId: o, conversationId: c, ids });
        return new Map(ids.map((id) => [id, { size: 4, pages: null, etag: "e1" }]));
      },
      async fetch(o, c, ids) {
        calls.push({ fn: "fetch", orgId: o, conversationId: c, ids });
        return new Map(
          ids.map((id) => [id, { mediaType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }]),
        );
      },
    };
    const out = await replayStep(
      deps(media),
      withImage,
      firstCall(),
      resolveCandidate(base(), { model: { provider: "model-eval", model: "eval-v" } }),
      new AbortController().signal,
    );
    expect(calls.map((c) => c.fn)).toEqual(["info", "fetch"]);
    for (const c of calls) {
      expect(c.orgId).toBe(snap.orgId);
      expect(c.conversationId).toBe(snap.conversationId);
      expect(c.ids).toEqual([attachmentId]);
    }
    const sent = (evalModelState().requests[0]?.messages ?? []).flatMap((m) =>
      typeof m.content === "string" ? [] : m.content,
    );
    expect(sent.some((b) => b.type === "image" && b.source.kind === "base64")).toBe(true);
    expect(out.drift).not.toContain("media_missing");

    // 不给附件来源：按「不再可用」占位，drift 含 media_missing
    resetEvalModel();
    const gone = await replayStep(
      deps(),
      withImage,
      firstCall(),
      resolveCandidate(base(), { model: { provider: "model-eval", model: "eval-v" } }),
      new AbortController().signal,
    );
    expect(gone.drift).toContain("media_missing");
  });

  it("an aborted signal stops the request", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      replayStep(
        deps(),
        snap,
        firstCall(),
        resolveCandidate(base(), { model: { provider: "model-eval", model: "eval-1" } }),
        ac.signal,
      ),
    ).rejects.toThrow();
  });
});
