import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { KERNEL_PURPOSES, type PurposeView } from "../../src/models/purposes.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { createOrg, PW, type Req, runConfig, session, startKernel } from "../helpers/runs.js";

/**
 * 模型用途映射（T6 / C9）：内核用途 `eval` 与插件 `permissions.models` 声明的用途；部署默认（企业管理员）+
 * 组织覆盖（组织管理员，`org.models.manage`）；`effective` 先取组织覆盖、再取部署默认；未映射 → 409。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api"], extensions: [MODEL_FAKE, MODEL_EVAL] },
    ),
  );
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let ent: Req;
let owner: Req;
let admin: Req;
let alice: Req;
let entId: string;
let adminId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_purpose_mappings, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  resetEvalModel();
  const accounts = new AccountsService(db);
  entId = (
    await accounts.createLocal({
      login: "ent",
      password: PW,
      displayName: "E",
      enterpriseAdmin: true,
    })
  ).id;
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  adminId = await mk("admin");
  const aliceId = await mk("alice");
  ent = await session(k, "ent");
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  admin = await session(k, "admin");
  alice = await session(k, "alice");
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const J = { model: { provider: "model-eval", model: "eval-j" }, params: {} };
const E1 = {
  model: { provider: "model-eval", model: "eval-1" },
  params: { "model-eval.level": 2 },
};

const adminUrl = (p?: string) =>
  `/api/v1/admin/model-purposes${p === undefined ? "" : `/${encodeURIComponent(p)}`}`;
const orgUrl = (p?: string) =>
  `/api/v1/orgs/${orgId}/model-purposes${p === undefined ? "" : `/${encodeURIComponent(p)}`}`;

async function list(req: Req, url: string): Promise<PurposeView[]> {
  const res = await req({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { purposes: PurposeView[] }).purposes;
}

async function put(req: Req, url: string, target: unknown): Promise<PurposeView> {
  const res = await req({ method: "PUT", url, payload: { target } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { purpose: PurposeView }).purpose;
}

const find = (views: PurposeView[], purpose: string) => views.find((v) => v.purpose === purpose);

const KERNEL = ["eval", "subagent_fast", "subagent_standard", "subagent_capable"];

describe("purpose list", () => {
  it("the kernel purposes (eval, sub-agent tiers) and plugin purposes; null when unmapped", async () => {
    expect(KERNEL_PURPOSES).toEqual([
      { purpose: "eval", kind: "chat", label: { zh: "评测评委", en: "Eval judge" } },
      {
        purpose: "subagent_fast",
        kind: "chat",
        label: { zh: "子代理：快速", en: "Sub-agent: fast" },
      },
      {
        purpose: "subagent_standard",
        kind: "chat",
        label: { zh: "子代理：标准", en: "Sub-agent: standard" },
      },
      {
        purpose: "subagent_capable",
        kind: "chat",
        label: { zh: "子代理：最强", en: "Sub-agent: capable" },
      },
    ]);
    const views = await list(ent, adminUrl());
    expect(views.map((v) => v.purpose)).toEqual([...KERNEL, "model-eval.summarize"]);
    expect(find(views, "eval")).toEqual({
      purpose: "eval",
      kind: "chat",
      label: { zh: "评测评委", en: "Eval judge" },
      declaredBy: "kernel",
      default: null,
      override: null,
      effective: null,
    });
    expect(find(views, "model-eval.summarize")).toMatchObject({
      kind: "chat",
      label: { zh: "摘要", en: "Summarize" },
      declaredBy: "model-eval",
      effective: null,
    });
    expect((await list(admin, orgUrl())).map((v) => v.purpose)).toEqual([
      ...KERNEL,
      "model-eval.summarize",
    ]);
  });
});

describe("effective 与解析", () => {
  it("先取组织覆盖、再取部署默认；清掉后回落；都没有 → model.unconfigured 409", async () => {
    await expect(k.purposes.resolve(orgId, "eval")).rejects.toMatchObject({
      code: "model.unconfigured",
    });

    const d = await put(ent, adminUrl("eval"), J);
    expect(d).toMatchObject({ default: J, override: null, effective: J });
    expect(find(await list(admin, orgUrl()), "eval")).toMatchObject({
      default: J,
      override: null,
      effective: J,
    });
    expect(await k.purposes.resolve(orgId, "eval")).toEqual(J);

    const o = await put(admin, orgUrl("eval"), E1);
    expect(o).toMatchObject({ default: J, override: E1, effective: E1 });
    expect(await k.purposes.resolve(orgId, "eval")).toEqual(E1);
    // 部署级视图不显示组织覆盖
    expect(find(await list(ent, adminUrl()), "eval")).toMatchObject({
      override: null,
      effective: J,
    });

    // 清掉组织覆盖 → 回落到部署默认；再清掉部署默认 → 未映射
    expect(await put(admin, orgUrl("eval"), null)).toMatchObject({ override: null, effective: J });
    expect(await put(ent, adminUrl("eval"), null)).toMatchObject({
      default: null,
      effective: null,
    });
    await expect(k.purposes.resolve(orgId, "eval")).rejects.toMatchObject({
      code: "model.unconfigured",
    });

    // 只有组织覆盖也行；部署默认改了不影响已覆盖的组织
    await put(admin, orgUrl("model-eval.summarize"), E1);
    expect(await k.purposes.resolve(orgId, "model-eval.summarize")).toEqual(E1);
    await put(ent, adminUrl("model-eval.summarize"), J);
    expect(await k.purposes.resolve(orgId, "model-eval.summarize")).toEqual(E1);

    // 审计：每次映射 / 清除一条 model.purpose_mapped
    const rows = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "org_id", "target", "detail"])
      .where("action", "=", "model.purpose_mapped")
      .orderBy("id")
      .execute();
    expect(rows.map((r) => [r.actor_account_id, r.org_id, r.target])).toEqual([
      [entId, null, "eval"],
      [adminId, orgId, "eval"],
      [adminId, orgId, "eval"],
      [entId, null, "eval"],
      [adminId, orgId, "model-eval.summarize"],
      [entId, null, "model-eval.summarize"],
    ]);
    expect(rows[0]?.detail).toEqual({ scope: "deployment", target: J });
    expect(rows[2]?.detail).toEqual({ scope: "org", target: null });
  });

  it("用途未声明 → model.purpose_unknown 404", async () => {
    const a = await ent({ method: "PUT", url: adminUrl("nope"), payload: { target: J } });
    expect(a.statusCode).toBe(404);
    expect(errCode(a)).toBe("model.purpose_unknown");
    const o = await admin({ method: "PUT", url: orgUrl("other.x"), payload: { target: J } });
    expect(o.statusCode).toBe(404);
    expect(errCode(o)).toBe("model.purpose_unknown");
    const err = await k.purposes.resolve(orgId, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("model.purpose_unknown");
  });

  it("目标模型不存在或参数不符它的声明 → 400", async () => {
    const bad = await admin({
      method: "PUT",
      url: orgUrl("eval"),
      payload: { target: { model: { provider: "model-eval", model: "nope" }, params: {} } },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");
    const params = await admin({
      method: "PUT",
      url: orgUrl("eval"),
      payload: { target: { ...E1, params: { "model-eval.level": 5 } } },
    });
    expect(params.statusCode, params.body).toBe(400);
    expect(errCode(params)).toBe("validation_failed");
    expect(params.body).toContain("model-eval.level");
    const unknownKey = await ent({
      method: "PUT",
      url: adminUrl("eval"),
      payload: { target: { ...J, params: { "x.y": 1 } } },
    });
    expect(unknownKey.statusCode, unknownKey.body).toBe(400);
    // 参数缺省为 {}
    expect(
      await put(ent, adminUrl("eval"), { model: { provider: "model-eval", model: "eval-j" } }),
    ).toMatchObject({ default: J });
  });
});

describe("chat", () => {
  it("按映射的模型发请求，参数按它的声明补默认值", async () => {
    await put(ent, adminUrl("eval"), J);
    const out = await k.purposes.chat(
      orgId,
      "eval",
      {
        system: [{ text: "Be a judge.", cache: false }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        maxOutputTokens: 64,
      },
      new AbortController().signal,
    );
    expect(out.provider).toBe("model-eval");
    expect(out.model).toBe("eval-j");
    expect(out.usage.inputTokens).toBe(100);
    const req = evalModelState().requests.at(-1);
    expect(req?.model).toBe("eval-j");
    expect(req?.params).toEqual({ "model-eval.level": 1 });
    expect(req?.maxOutputTokens).toBe(64);
  });

  it("输出上限不超过目标模型的 maxOutputTokens（eval-j 为 2000）", async () => {
    await put(ent, adminUrl("eval"), J);
    await k.purposes.chat(
      orgId,
      "eval",
      {
        system: [{ text: "Be a judge.", cache: false }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        maxOutputTokens: 50_000,
      },
      new AbortController().signal,
    );
    expect(evalModelState().requests.at(-1)?.maxOutputTokens).toBe(2000);
  });
});

describe("权限", () => {
  it("部署级端点只给企业管理员；组织端点要 org.models.manage（admin 起）", async () => {
    for (const req of [owner, admin, alice]) {
      expect((await req({ method: "GET", url: adminUrl() })).statusCode).toBe(403);
      expect(
        (await req({ method: "PUT", url: adminUrl("eval"), payload: { target: J } })).statusCode,
      ).toBe(403);
    }
    const g = await alice({ method: "GET", url: orgUrl() });
    expect(g.statusCode).toBe(403);
    const p = await alice({ method: "PUT", url: orgUrl("eval"), payload: { target: J } });
    expect(p.statusCode).toBe(403);
    expect((await owner({ method: "GET", url: orgUrl() })).statusCode).toBe(200);
    expect((await k.http.inject({ method: "GET", url: orgUrl() })).statusCode).toBe(401);
    expect((await k.http.inject({ method: "GET", url: adminUrl() })).statusCode).toBe(401);
  });
});
