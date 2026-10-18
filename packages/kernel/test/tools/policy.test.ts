import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import type { PolicyContext } from "../../src/tools/pipeline.js";
import {
  createDecidePolicy,
  decide,
  type PolicyInput,
  R3_FIXED_ASK_TOOL_KEYS,
} from "../../src/tools/policy.js";
import { type ResolvedTool, specHash } from "../../src/tools/registry.js";
import { eventsOf } from "../helpers/runs.js";
import { seedApp, seedConversation } from "../helpers/tool-fixtures.js";

// ---- decide 真值表（纯函数） ----

describe("decide", () => {
  const base: PolicyInput = { appDefault: "allow", fixedAsk: false, grant: null };
  const POLICIES = ["allow", "ask", "deny"] as const;
  const OVERRIDES = [undefined, "ask", "deny"] as const;
  const GRANTS = [null, "session", "always"] as const;
  const rank = { allow: 0, ask: 1, deny: 2 } as const;

  it("全组合：取 appDefault / agentOverride / fixedAsk 中最严者；授权只能把 ask 放行为 allow（fixedAsk 除外）", () => {
    for (const appDefault of POLICIES) {
      for (const agentOverride of OVERRIDES) {
        for (const fixedAsk of [false, true]) {
          for (const grant of GRANTS) {
            const got = decide({
              appDefault,
              ...(agentOverride !== undefined && { agentOverride }),
              fixedAsk,
              grant,
            });
            let strict: number = rank[appDefault];
            if (agentOverride !== undefined) strict = Math.max(strict, rank[agentOverride]);
            if (fixedAsk) strict = Math.max(strict, rank.ask);
            const expected =
              strict === 2
                ? "deny"
                : strict === 1
                  ? grant && !fixedAsk
                    ? "allow"
                    : "ask"
                  : "allow";
            expect(got, JSON.stringify({ appDefault, agentOverride, fixedAsk, grant })).toBe(
              expected,
            );
          }
        }
      }
    }
  });

  it("deny 不可被授权越过", () => {
    expect(decide({ ...base, appDefault: "deny", grant: "always" })).toBe("deny");
    expect(decide({ ...base, agentOverride: "deny", grant: "session" })).toBe("deny");
  });

  it("R3 / requiresUserInteraction 至少 ask，且记住的授权不放行", () => {
    expect(decide({ ...base, fixedAsk: true })).toBe("ask");
    expect(decide({ ...base, fixedAsk: true, grant: "always" })).toBe("ask");
    expect(decide({ ...base, fixedAsk: true, appDefault: "deny" })).toBe("deny");
  });

  it("agent 放宽无效：组织默认 deny / ask 时 agent 覆盖为 ask 不改变结果", () => {
    expect(decide({ ...base, appDefault: "deny", agentOverride: "ask" })).toBe("deny");
    expect(decide({ ...base, appDefault: "ask", agentOverride: "ask" })).toBe("ask");
    expect(decide({ ...base, appDefault: "allow", agentOverride: "ask" })).toBe("ask");
  });

  it("R3 固定询问清单在 M3 为空（内置 / 应用工具都不在清单上）", () => {
    expect(R3_FIXED_ASK_TOOL_KEYS.size).toBe(0);
  });
});

// ---- 执行时判定（读 PG） ----

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
const silent = createLogger("error", { write: () => {} });
const cfg = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => cfg;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = new EventLog(db, createBus(redis, sub, "kernel"));
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const agentDef: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "s-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  tools: [],
  toolPolicies: {},
};

let seed: Awaited<ReturnType<typeof seedConversation>>;
let appId: string;
let runId: string;
let ctx: PolicyContext;

const SPEC: ToolSpec = {
  name: "create_doc",
  description: "Create.",
  inputSchema: { type: "object" },
};

function appTool(overrides: Partial<ResolvedTool> = {}): ResolvedTool {
  return {
    key: "docs__create_doc",
    source: { kind: "app", appId, name: "create_doc" },
    spec: SPEC,
    specHash: specHash(SPEC),
    defaultPolicy: "allow",
    ...overrides,
  };
}

function pluginTool(spec: ToolSpec, overrides: Partial<ResolvedTool> = {}): ResolvedTool {
  return {
    key: `probe__${spec.name}`,
    source: { kind: "plugin", plugin: "probe", name: spec.name },
    spec,
    specHash: specHash(spec),
    defaultPolicy: "allow",
    ...overrides,
  };
}

async function setAppTool(
  policy: "allow" | "ask" | "deny",
  hash = specHash(SPEC),
  status = "enabled",
) {
  await sql`INSERT INTO capybara.app_tools (app_id, name, spec, spec_hash, status, default_policy)
    VALUES (${appId}, 'create_doc', ${JSON.stringify(SPEC)}::jsonb, ${hash}, ${status}, ${policy})
    ON CONFLICT (app_id, name) DO UPDATE SET default_policy = EXCLUDED.default_policy,
      spec_hash = EXCLUDED.spec_hash, status = EXCLUDED.status`.execute(raw);
}

async function setMember(accountId: string, role: string) {
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${seed.orgId}, ${accountId}, ${role})
    ON CONFLICT (org_id, account_id) DO UPDATE SET role = EXCLUDED.role`.execute(raw);
}

beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  seed = await seedConversation(raw);
  appId = await seedApp(raw, seed.orgId, seed.accountId, { slug: "docs", name: "Docs" });
  await setMember(seed.accountId, "member");
  runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: seed.conversationId,
      status: "running",
      agent_version: 1,
      trigger_account_id: seed.accountId,
      trigger_seq: 0,
    })
    .execute();
  ctx = {
    orgId: seed.orgId,
    accountId: seed.accountId,
    agentId: seed.agentId,
    conversationId: seed.conversationId,
    runId,
  };
});

describe("createDecidePolicy（执行时实时读取，R5）", () => {
  it("应用工具：每次调用重读 app_tools.default_policy（不信 ResolvedTool 上的旧值）", async () => {
    const policy = createDecidePolicy(db);
    await setAppTool("deny");
    expect(await policy(appTool({ defaultPolicy: "allow" }), agentDef, ctx)).toBe("deny");
    await setAppTool("allow");
    expect(await policy(appTool({ defaultPolicy: "deny" }), agentDef, ctx)).toBe("allow");
    // 工具被停用 / 删除 → 拒绝
    await setAppTool("allow", specHash(SPEC), "disabled");
    expect(await policy(appTool(), agentDef, ctx)).toBe("deny");
  });

  it("ask → 指向发起人的审批请求（带 specHash 与来源应用）", async () => {
    await setAppTool("ask");
    const d = await createDecidePolicy(db)(appTool(), agentDef, ctx);
    expect(d).toEqual({
      ask: {
        toolKey: "docs__create_doc",
        specHash: specHash(SPEC),
        appId,
        requestedFor: seed.accountId,
        approverRole: null,
      },
    });
  });

  it("agent 收紧：运行版本或当前版本（重读）的 toolPolicies 取更严者；旧版本缺字段视为空", async () => {
    await setAppTool("allow");
    const policy = createDecidePolicy(db);
    const { toolPolicies: _, ...legacy } = agentDef;
    expect(await policy(appTool(), legacy as AgentDefinition, ctx)).toBe("allow");
    expect(
      await policy(appTool(), { ...agentDef, toolPolicies: { docs__create_doc: "ask" } }, ctx),
    ).toMatchObject({ ask: {} });
    // 运行中负责人把当前版本收紧为 deny：立即生效
    await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
      VALUES (${seed.agentId}, 2, ${JSON.stringify({ ...agentDef, toolPolicies: { docs__create_doc: "deny" } })}::jsonb,
        ${seed.accountId})`.execute(raw);
    await sql`UPDATE capybara.agents SET current_version = 2 WHERE id = ${seed.agentId}`.execute(
      raw,
    );
    expect(await policy(appTool(), agentDef, ctx)).toBe("deny");
  });

  it("记住的授权：spec_hash 一致才把 ask 放行；定义变化后失效（D8）", async () => {
    await setAppTool("ask");
    const policy = createDecidePolicy(db);
    const hash = specHash(SPEC);
    await sql`INSERT INTO capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash)
      VALUES (${seed.conversationId}, 'docs__create_doc', ${hash})`.execute(raw);
    expect(await policy(appTool(), agentDef, ctx)).toBe("allow");
    await sql`UPDATE capybara.conversation_tool_grants SET spec_hash = 'stale'`.execute(raw);
    expect(await policy(appTool(), agentDef, ctx)).toMatchObject({ ask: {} });

    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${seed.orgId}, ${seed.accountId}, ${seed.agentId}, 'docs__create_doc', ${hash})`.execute(
      raw,
    );
    expect(await policy(appTool(), agentDef, ctx)).toBe("allow");
    // 应用刷新后定义指纹变化：旧授权不再生效
    const spec2 = { ...SPEC, description: "Create v2." };
    await setAppTool("ask", specHash(spec2));
    expect(
      await policy(appTool({ spec: spec2, specHash: specHash(spec2) }), agentDef, ctx),
    ).toMatchObject({ ask: {} });
    // 授权不越过 deny
    await setAppTool("deny");
    expect(await policy(appTool(), agentDef, ctx)).toBe("deny");
  });

  it("requiresUserInteraction 的插件工具至少 ask，授权不放行", async () => {
    const spec: ToolSpec = {
      name: "confirm",
      description: "Confirm.",
      inputSchema: { type: "object" },
      annotations: { requiresUserInteraction: true },
    };
    const tool = pluginTool(spec);
    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${seed.orgId}, ${seed.accountId}, ${seed.agentId}, ${tool.key}, ${tool.specHash})`.execute(
      raw,
    );
    expect(await createDecidePolicy(db)(tool, agentDef, ctx)).toMatchObject({
      ask: { toolKey: "probe__confirm", requestedFor: seed.accountId },
    });
  });

  it("R1：requiredRole 高于发起人实时角色 → 按角色升级（approverRole = 所需角色，requestedFor = null）", async () => {
    const tool = pluginTool(
      { name: "admin_op", description: "Admin op.", inputSchema: { type: "object" } },
      { requiredRole: "admin" },
    );
    const policy = createDecidePolicy(db);
    expect(await policy(tool, agentDef, ctx)).toEqual({
      ask: {
        toolKey: "probe__admin_op",
        specHash: tool.specHash,
        appId: null,
        requestedFor: null,
        approverRole: "admin",
      },
    });
    // 运行中被提升为 admin：立即按自己的权限执行
    await setMember(seed.accountId, "admin");
    expect(await policy(tool, agentDef, ctx)).toBe("allow");
    // 角色不足时记住的授权也不放行
    await setMember(seed.accountId, "guest");
    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${seed.orgId}, ${seed.accountId}, ${seed.agentId}, ${tool.key}, ${tool.specHash})`.execute(
      raw,
    );
    expect(await policy(tool, agentDef, ctx)).toMatchObject({ ask: { approverRole: "admin" } });
    // deny 仍是 deny
    expect(await policy({ ...tool, defaultPolicy: "deny" }, agentDef, ctx)).toBe("deny");
    // 发起人已不是成员 → 拒绝
    await sql`DELETE FROM capybara.memberships WHERE account_id = ${seed.accountId}`.execute(raw);
    expect(await policy(tool, agentDef, ctx)).toBe("deny");
  });
});

describe("ApprovalsService.request", () => {
  it("插入 pending 审批（expires_at = now + approvalTimeoutHours）并写 approval_requested；按 (run, call) 幂等", async () => {
    const approvals = new ApprovalsService({ db, eventLog, config, log: silent });
    const input = {
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      runId,
      step: 1,
      callId: "c1",
      toolKey: "docs__create_doc",
      specHash: specHash(SPEC),
      appId,
      input: { title: "x" },
      requestedFor: seed.accountId,
      approverRole: null,
    };
    const before = Date.now();
    const a = await approvals.request(input);
    expect(a).toMatchObject({
      orgId: seed.orgId,
      runId,
      callId: "c1",
      toolKey: "docs__create_doc",
      status: "pending",
      requestedFor: seed.accountId,
      approverRole: null,
      scope: null,
      input: { title: "x" },
    });
    const ttl = new Date(a.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(cfg.tools.approvalTimeoutHours * 3600_000 - 60_000);
    expect(ttl).toBeLessThan(cfg.tools.approvalTimeoutHours * 3600_000 + 60_000);

    const again = await approvals.request({ ...input, input: { title: "other" } });
    expect(again.id).toBe(a.id);
    expect(again.input).toEqual({ title: "x" });

    const evs = (await eventsOf(db, seed.conversationId)).filter(
      (e) => e.type === "approval_requested",
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      runId,
      payload: {
        step: 1,
        callId: "c1",
        approvalId: a.id,
        toolKey: "docs__create_doc",
        expiresAt: a.expiresAt,
      },
    });
  });

  it("requestedFor 与 approverRole 都为空 → 拒绝创建", async () => {
    const approvals = new ApprovalsService({ db, eventLog, config, log: silent });
    await expect(
      approvals.request({
        orgId: seed.orgId,
        conversationId: seed.conversationId,
        runId,
        step: 1,
        callId: "c2",
        toolKey: "docs__create_doc",
        specHash: "h",
        appId: null,
        input: {},
        requestedFor: null,
        approverRole: null,
      }),
    ).rejects.toThrow();
  });
});
