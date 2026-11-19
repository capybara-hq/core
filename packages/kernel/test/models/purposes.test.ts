import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import {
  KERNEL_PURPOSES,
  ModelPurposesService,
  type PurposeView,
  withDeclaredByNames,
} from "../../src/models/purposes.js";
import { ProviderListError, ProviderRegistry } from "../../src/runtime/providers.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * 模型用途映射（T6 / C9）：内核用途 `eval` 与插件 `permissions.models` 声明的用途；部署默认（超级管理员）+
 * 组织覆盖（组织管理员，`org.models.manage`）；`effective` 先取组织覆盖、再取部署默认；未映射 → 409。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);
const EMBED_CONSUMER = fileURLToPath(
  new URL("../fixtures/plugins/embed-consumer/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let redis: Redis;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [MODEL_FAKE, MODEL_EVAL, EMBED_CONSUMER],
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1" },
              { id: "fake-vision", vision: true },
              { id: "fake-embed", kind: "embedding", dimensions: [4] },
              { id: "fake-image", kind: "image_generation" },
              { id: "fake-image-1", kind: "image_generation", maxImages: 1, maxReferenceImages: 0 },
              { id: "fake-image-3", kind: "image_generation", maxImages: 3 },
            ],
          },
        },
      },
    ),
  );
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
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
    "capybara.model_disabled, capybara.model_purpose_mappings, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  // the disabled lists are cached in Redis (evicted only by writes)
  const cached = await redis.keys("cache:capk:model-disabled:*");
  if (cached.length > 0) await redis.del(...cached);
  resetEvalModel();
  const accounts = accountsFor(db);
  entId = (
    await accounts.createLocal({
      login: "ent",
      password: PW,
      displayName: "E",
      superAdmin: true,
    })
  ).id;
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  adminId = await mk("admin");
  const aliceId = await mk("alice");
  ent = await session(k, "ent");
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
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

const KERNEL = [
  "eval",
  "title",
  "review",
  "web_fetch",
  "subagent_fast",
  "subagent_standard",
  "subagent_capable",
  "image",
  "vision",
];

describe("purpose list", () => {
  it("the kernel purposes (eval, title, review, web_fetch, sub-agent tiers) and plugin purposes; null when unmapped", async () => {
    expect(KERNEL_PURPOSES).toEqual([
      { purpose: "eval", kind: "chat", label: { zh: "评测评委", en: "Eval judge" } },
      { purpose: "title", kind: "chat", label: { zh: "会话标题", en: "Conversation titles" } },
      { purpose: "review", kind: "chat", label: { zh: "命令审查", en: "Command review" } },
      { purpose: "web_fetch", kind: "chat", label: { zh: "网页提取", en: "Web page extraction" } },
      {
        purpose: "subagent_fast",
        kind: "chat",
        label: { zh: "子智能体：快速", en: "Sub-agent: fast" },
      },
      {
        purpose: "subagent_standard",
        kind: "chat",
        label: { zh: "子智能体：标准", en: "Sub-agent: standard" },
      },
      {
        purpose: "subagent_capable",
        kind: "chat",
        label: { zh: "子智能体：最强", en: "Sub-agent: capable" },
      },
      {
        purpose: "image",
        kind: "image_generation",
        label: { zh: "图片生成", en: "Image generation" },
      },
      {
        purpose: "vision",
        kind: "chat",
        requires: { vision: true },
        label: { zh: "识图", en: "Vision" },
      },
    ]);
    const views = await list(ent, adminUrl());
    expect(views.map((v) => v.purpose)).toEqual([
      ...KERNEL,
      "model-eval.summarize",
      "embed-consumer.memory",
    ]);
    expect(find(views, "eval")).toEqual({
      purpose: "eval",
      kind: "chat",
      label: { zh: "评测评委", en: "Eval judge" },
      declaredBy: "kernel",
      declaredByName: null,
      default: null,
      override: null,
      effective: null,
    });
    // the fixture plugin has no display name
    expect(find(views, "model-eval.summarize")).toMatchObject({
      kind: "chat",
      label: { zh: "摘要", en: "Summarize" },
      declaredBy: "model-eval",
      declaredByName: null,
      effective: null,
    });
    expect(find(views, "embed-consumer.memory")).toMatchObject({
      kind: "embedding",
      declaredBy: "embed-consumer",
    });
    expect((await list(admin, orgUrl())).map((v) => v.purpose)).toEqual([
      ...KERNEL,
      "model-eval.summarize",
      "embed-consumer.memory",
    ]);
  });
});

describe("withDeclaredByNames", () => {
  it("names the declaring extension; a kernel purpose has none and is never looked up", async () => {
    const view = (purpose: string, declaredBy: string): PurposeView => ({
      purpose,
      kind: "chat",
      label: { zh: purpose, en: purpose },
      declaredBy,
      default: null,
      override: null,
      effective: null,
    });
    const asked: string[][] = [];
    const names = {
      many: async (n: string[]) => {
        asked.push(n);
        return new Map([["ext-a", { zh: "扩展甲", en: "Ext A" }]]);
      },
    };
    const out = await withDeclaredByNames(
      [view("eval", "kernel"), view("a.x", "ext-a"), view("b.y", "ext-b")],
      names,
    );
    expect(asked).toEqual([["ext-a", "ext-b"]]);
    expect(out.map((v) => v.declaredByName)).toEqual([null, { zh: "扩展甲", en: "Ext A" }, null]);
  });
});

describe("effective 与解析", () => {
  it("先取组织覆盖、再取部署默认；清掉后回落；都没有 → model.unconfigured 409", async () => {
    await expect(k.app.get(ModelPurposesService).resolve(orgId, "eval")).rejects.toMatchObject({
      code: "model.unconfigured",
    });

    const d = await put(ent, adminUrl("eval"), J);
    expect(d).toMatchObject({ default: J, override: null, effective: J });
    expect(find(await list(admin, orgUrl()), "eval")).toMatchObject({
      default: J,
      override: null,
      effective: J,
    });
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "eval")).toEqual(J);

    const o = await put(admin, orgUrl("eval"), E1);
    expect(o).toMatchObject({ default: J, override: E1, effective: E1 });
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "eval")).toEqual(E1);
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
    await expect(k.app.get(ModelPurposesService).resolve(orgId, "eval")).rejects.toMatchObject({
      code: "model.unconfigured",
    });

    // 只有组织覆盖也行；部署默认改了不影响已覆盖的组织
    await put(admin, orgUrl("model-eval.summarize"), E1);
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "model-eval.summarize")).toEqual(
      E1,
    );
    await put(ent, adminUrl("model-eval.summarize"), J);
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "model-eval.summarize")).toEqual(
      E1,
    );

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
    const err = await k.app
      .get(ModelPurposesService)
      .resolve(orgId, "nope")
      .catch((e: unknown) => e);
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

describe("kinds and disabled models (spec B §5.3)", () => {
  const FAKE_1 = { model: { provider: "model-fake", model: "fake-1" }, params: {} };
  const EMBED = { model: { provider: "model-fake", model: "fake-embed" }, params: {} };
  const disable = (req: Req, url: string, change: { disable?: string[]; enable?: string[] }) =>
    req({ method: "PATCH", url, payload: change });
  const orgDisabledUrl = () => `/api/v1/orgs/${orgId}/models/model-fake/disabled`;

  it("a target's kind must equal the purpose's kind", async () => {
    for (const [req, url] of [
      [ent, adminUrl("embed-consumer.memory")],
      [admin, orgUrl("embed-consumer.memory")],
    ] as const) {
      const res = await req({ method: "PUT", url, payload: { target: FAKE_1 } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
      expect(res.body).toContain("needs an embedding model");
    }
    const chat = await admin({ method: "PUT", url: orgUrl("eval"), payload: { target: EMBED } });
    expect(chat.statusCode, chat.body).toBe(400);
    expect(chat.body).toContain("needs a chat model");
    expect(await put(admin, orgUrl("embed-consumer.memory"), EMBED)).toMatchObject({
      effective: EMBED,
    });
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "embed-consumer.memory")).toEqual(
      EMBED,
    );
  });

  it("image purpose maps to an image model", async () => {
    const IMG = { model: { provider: "model-fake", model: "fake-image" }, params: {} };
    expect(await put(ent, adminUrl("image"), IMG)).toMatchObject({
      kind: "image_generation",
      effective: IMG,
    });
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "image")).toEqual(IMG);
  });

  it("image purpose refuses a chat model", async () => {
    for (const [req, url] of [
      [ent, adminUrl("image")],
      [admin, orgUrl("image")],
    ] as const) {
      const res = await req({ method: "PUT", url, payload: { target: FAKE_1 } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
      expect(res.body).toContain("this purpose needs an image_generation model, not chat");
    }
  });

  it("unmapped image purpose resolves to model.unconfigured", async () => {
    const err = await k.app
      .get(ModelPurposesService)
      .resolve(orgId, "image")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("model.unconfigured");
  });

  it("an org override on a model disabled in the org is refused", async () => {
    expect((await disable(admin, orgDisabledUrl(), { disable: ["fake-1"] })).statusCode).toBe(200);
    const res = await admin({ method: "PUT", url: orgUrl("title"), payload: { target: FAKE_1 } });
    expect(res.statusCode, res.body).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
    // the deployment default is checked against the platform's list only
    expect(await put(ent, adminUrl("title"), FAKE_1)).toMatchObject({ default: FAKE_1 });
  });

  it("a default disabled in an org makes the purpose unconfigured there only", async () => {
    await put(ent, adminUrl("title"), FAKE_1);
    const other = await createOrgWithProviders(k, owner, "Other");
    const purposes = k.app.get(ModelPurposesService);
    expect((await disable(admin, orgDisabledUrl(), { disable: ["fake-1"] })).statusCode).toBe(200);
    await expect(purposes.resolve(orgId, "title")).rejects.toMatchObject({
      code: "model.unconfigured",
    });
    expect(await purposes.resolve(other, "title")).toEqual(FAKE_1);
    // the org's view still shows the mapping; only resolving treats it as unconfigured
    expect(find(await list(admin, orgUrl()), "title")).toMatchObject({ effective: FAKE_1 });
    // an override disabled later is unconfigured too (no silent fall back to the default)
    expect((await disable(admin, orgDisabledUrl(), { enable: ["fake-1"] })).statusCode).toBe(200);
    await put(admin, orgUrl("title"), FAKE_1);
    expect(
      (await disable(ent, "/api/v1/admin/models/model-fake/disabled", { disable: ["fake-1"] }))
        .statusCode,
    ).toBe(200);
    await expect(purposes.resolve(orgId, "title")).rejects.toMatchObject({
      code: "model.unconfigured",
    });
    await expect(purposes.resolve(other, "title")).rejects.toMatchObject({
      code: "model.unconfigured",
    });
  });
});

describe("vision purpose", () => {
  const FAKE_1 = { model: { provider: "model-fake", model: "fake-1" }, params: {} };
  const VISION = { model: { provider: "model-fake", model: "fake-vision" }, params: {} };

  it("vision purpose refuses a chat model without vision on save", async () => {
    for (const [req, url] of [
      [ent, adminUrl("vision")],
      [admin, orgUrl("vision")],
    ] as const) {
      const res = await req({ method: "PUT", url, payload: { target: FAKE_1 } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
      expect(res.body).toContain("target.model");
    }
  });

  it("vision purpose resolves a vision model", async () => {
    expect(await put(ent, adminUrl("vision"), VISION)).toMatchObject({
      requires: { vision: true },
      effective: VISION,
    });
    expect(await k.app.get(ModelPurposesService).resolve(orgId, "vision")).toEqual(VISION);
  });

  it("a vision target that loses vision is unusable", async () => {
    await put(ent, adminUrl("vision"), VISION);
    const purposes = k.app.get(ModelPurposesService);
    const availability = async () =>
      (await purposes.availability(orgId)).find((a) => a.purpose === "vision");
    expect(await availability()).toEqual({ purpose: "vision", available: true });
    // the org keeps its own copy of model-fake's config, which re-declares the model without vision
    for (const [url, payload] of [
      [`/api/v1/orgs/${orgId}/extensions/model-fake`, { enabled: true }],
      [
        `/api/v1/orgs/${orgId}/extensions/model-fake/overrides`,
        { values: { models: [{ id: "fake-vision", vision: false }] } },
      ],
    ] as const) {
      const res = await owner({ method: "PUT", url, payload });
      expect(res.statusCode, res.body).toBe(200);
    }
    await expect(purposes.resolve(orgId, "vision")).rejects.toMatchObject({
      code: "model.unconfigured",
    });
    expect(await availability()).toEqual({ purpose: "vision", available: false });
  });
});

describe("a target the org cannot use", () => {
  it("a default missing from the org's own provider list is unconfigured there only", async () => {
    const FAKE_1 = { model: { provider: "model-fake", model: "fake-1" }, params: {} };
    await put(ent, adminUrl("title"), FAKE_1);
    const other = await createOrgWithProviders(k, owner, "Other");
    const purposes = k.app.get(ModelPurposesService);
    // the org keeps its own copy of model-fake's config, whose list has no fake-1
    for (const [url, payload] of [
      [`/api/v1/orgs/${orgId}/extensions/model-fake`, { enabled: true }],
      [
        `/api/v1/orgs/${orgId}/extensions/model-fake/overrides`,
        { values: { models: [{ id: "mine" }] } },
      ],
    ] as const) {
      const res = await owner({ method: "PUT", url, payload });
      expect(res.statusCode, res.body).toBe(200);
    }
    await expect(purposes.resolve(orgId, "title")).rejects.toMatchObject({
      code: "model.unconfigured",
    });
    expect(await purposes.resolve(other, "title")).toEqual(FAKE_1);
  });

  it("a provider whose list fails keeps the mapping; the call itself then fails retryably", async () => {
    await put(ent, adminUrl("title"), J);
    const purposes = k.app.get(ModelPurposesService);
    const clear = async () => {
      for (const pattern of ["cache:*", "capk:models-failed:*"]) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) await redis.del(...keys);
      }
    };
    await clear();
    evalModelState().listFails = true;
    try {
      expect(await purposes.resolve(orgId, "title")).toEqual(J);
      const err = await k.app
        .get(ProviderRegistry)
        .resolve(orgId, J.model)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderListError);
    } finally {
      evalModelState().listFails = false;
      await clear();
    }
  });
});

describe("chat", () => {
  it("按映射的模型发请求，参数按它的声明补默认值", async () => {
    await put(ent, adminUrl("eval"), J);
    const out = await k.app.get(ModelPurposesService).chat(
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

  it("paramDefaults fill only declared, unset parameters whose value fits", async () => {
    const send = () =>
      k.app.get(ModelPurposesService).chat(
        orgId,
        "eval",
        {
          system: [{ text: "Be a judge.", cache: false }],
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
          maxOutputTokens: 64,
        },
        new AbortController().signal,
        // thinking is not declared by eval-j: dropped like any other parameter
        { paramDefaults: { "model-eval.level": 2, thinking: "off" } },
      );
    await put(ent, adminUrl("eval"), J);
    await send();
    expect(evalModelState().requests.at(-1)?.params).toEqual({ "model-eval.level": 2 });
    // the purpose's own setting wins
    await put(ent, adminUrl("eval"), { ...J, params: { "model-eval.level": 0 } });
    await send();
    expect(evalModelState().requests.at(-1)?.params).toEqual({ "model-eval.level": 0 });
    // a value the declaration rejects is dropped, the declared default stays
    await put(ent, adminUrl("eval"), J);
    await k.app
      .get(ModelPurposesService)
      .chat(
        orgId,
        "eval",
        { system: [], messages: [], tools: [], maxOutputTokens: 64 },
        new AbortController().signal,
        { paramDefaults: { "model-eval.level": 5 } },
      );
    expect(evalModelState().requests.at(-1)?.params).toEqual({ "model-eval.level": 1 });
  });

  it("输出上限不超过目标模型的 maxOutputTokens（eval-j 为 2000）", async () => {
    await put(ent, adminUrl("eval"), J);
    await k.app.get(ModelPurposesService).chat(
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
  it("部署级端点只给超级管理员；组织端点要 org.models.manage（admin 起）", async () => {
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

describe("purpose availability for a member", () => {
  const availUrl = () => `/api/v1/orgs/${orgId}/model-purposes/available`;
  const FAKE_IMAGE = { model: { provider: "model-fake", model: "fake-image" }, params: {} };
  const imageAvailable = async (req: Req) => {
    const res = await req({ method: "GET", url: availUrl() });
    expect(res.statusCode, res.body).toBe(200);
    const { purposes } = res.json() as { purposes: { purpose: string; available: boolean }[] };
    expect(Object.keys(purposes[0] ?? {}).sort()).toEqual(["available", "purpose"]);
    return purposes.find((p) => p.purpose === "image")?.available;
  };

  /** The kernel here has no object store: `GenerateImage` needs one, so it is faked available. */
  const withStorage = (available = true) =>
    vi.spyOn(k.app.get(StorageService), "available", "get").mockReturnValue(available);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a plain member reads false unmapped, true once mapped, false once the target is disabled", async () => {
    withStorage();
    // not an org.models.manage action: the full list refuses the member
    expect((await alice({ method: "GET", url: orgUrl() })).statusCode).toBe(403);
    expect(await imageAvailable(alice)).toBe(false);
    await put(admin, orgUrl("image"), FAKE_IMAGE);
    expect(await imageAvailable(alice)).toBe(true);
    expect(
      (
        await admin({
          method: "PATCH",
          url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
          payload: { disable: ["fake-image"] },
        })
      ).statusCode,
    ).toBe(200);
    expect(await imageAvailable(alice)).toBe(false);
  });

  it("image reads false without object storage, as GenerateImage is unavailable then", async () => {
    await put(admin, orgUrl("image"), FAKE_IMAGE);
    withStorage(true);
    expect(await imageAvailable(alice)).toBe(true);
    withStorage(false);
    expect(await imageAvailable(alice)).toBe(false);
  });

  it("image reads false while the provider's model list fails, as for GenerateImage", async () => {
    await put(admin, orgUrl("image"), FAKE_IMAGE);
    withStorage();
    const registry = k.app.get(ProviderRegistry);
    const original = registry.resolve.bind(registry);
    vi.spyOn(registry, "resolve").mockImplementation(async (...args) => {
      if (args[1].provider === "model-fake") {
        throw new ProviderListError("model-fake", new Error("list down"));
      }
      return original(...args);
    });
    expect(await imageAvailable(alice)).toBe(false);
  });

  it("GenerateImage lists only the counts the org's image model accepts", async () => {
    withStorage();
    const listed = async () => {
      const { tools } = await k.app
        .get(ToolRegistry)
        .forAgent(orgId, { disabledTools: [], source: "web" });
      const spec = tools.find((t) => t.key === "GenerateImage")?.spec;
      if (spec === undefined) throw new Error("GenerateImage is not listed");
      // biome-ignore lint/suspicious/noExplicitAny: schema properties are probed by name
      return (spec.inputSchema as { properties: Record<string, any> }).properties;
    };
    const mapTo = (model: string) =>
      put(admin, orgUrl("image"), { model: { provider: "model-fake", model }, params: {} });
    await mapTo("fake-image-1");
    const one = await listed();
    expect(one.n).toBeUndefined();
    expect(one.reference_images).toBeUndefined();
    expect(await imageAvailable(alice)).toBe(true);
    await mapTo("fake-image-3");
    expect((await listed()).n.maximum).toBe(3);
  });
});
