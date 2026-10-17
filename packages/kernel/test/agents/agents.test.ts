import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService, type AgentView } from "../../src/agents/agents.service.js";
import { type AgentDefinition, AgentDefinitionSchema } from "../../src/agents/definition.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import type { OrgRole } from "../../src/orgs/roles.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let orgs: OrgsService;
let agents: AgentsService;

const PW = "correct horse battery";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = new MembersService(db);
  orgs = new OrgsService(db, new SettingsService(db), new ApiTokenService(db));
  agents = new AgentsService(db, new ProviderRegistry(k.host, redis));
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  await redis.flushdb();
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

let n = 0;
const account = (): Promise<Account> => {
  n++;
  return accounts.createLocal({ login: `user${n}`, password: PW, displayName: `U${n}` });
};

/** 新建组织（owner 为新账号），按 roles 加入新成员；返回组织 id 与各账号。 */
async function orgWith<R extends string>(
  roles: Record<R, OrgRole>,
): Promise<{ orgId: string; owner: Account } & Record<R, Account>> {
  const owner = await account();
  const org = await orgs.create({ name: "Acme", slug: `acme-${n}` }, owner);
  const out: Record<string, Account> = {};
  for (const [key, role] of Object.entries(roles) as [R, OrgRole][]) {
    const a = await account();
    await members.add(org.id, a.id, role, owner.id);
    out[key] = a;
  }
  return { orgId: org.id, owner, ...(out as Record<R, Account>) };
}

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition =>
  AgentDefinitionSchema.parse({
    name: "Helper",
    model: { provider: "model-fake", model: "fake-1" },
    ...over,
  });

describe("AgentDefinitionSchema", () => {
  it("填默认值", () => {
    expect(def()).toEqual({
      name: "Helper",
      avatarUrl: null,
      instructions: "",
      model: { provider: "model-fake", model: "fake-1" },
      fallback: null,
      effort: null,
      tools: [],
    });
  });
  it("拒绝空名、超长名、非法 effort、非空 tools", () => {
    const base = { model: { provider: "p", model: "m" } };
    expect(AgentDefinitionSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse({ ...base, name: "x".repeat(81) }).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse({ ...base, name: "a", effort: "huge" }).success).toBe(
      false,
    );
    expect(AgentDefinitionSchema.safeParse({ ...base, name: "a", tools: ["x"] }).success).toBe(
      false,
    );
    expect(AgentDefinitionSchema.safeParse({ ...base, name: "a", effort: "xhigh" }).success).toBe(
      true,
    );
  });
});

describe("AgentsService 版本", () => {
  it("创建后版本为 1；只改 visibility 不产生新版本；改 instructions 版本变 2，旧版本仍可读", async () => {
    const { orgId, owner } = await orgWith({});
    const { agent, warnings } = await agents.create(orgId, owner.id, {
      definition: def({ instructions: "v1" }),
      visibility: "private",
    });
    expect(warnings).toEqual([]);
    expect(agent).toMatchObject({
      orgId,
      ownerAccountId: owner.id,
      visibility: "private",
      currentVersion: 1,
      memberIds: null,
    });
    expect(agent.definition.instructions).toBe("v1");

    const vis = await agents.update(orgId, agent.id, owner.id, { visibility: "org" });
    expect(vis.agent.currentVersion).toBe(1);
    expect(vis.agent.visibility).toBe("org");

    const same = await agents.update(orgId, agent.id, owner.id, {
      definition: def({ instructions: "v1" }),
    });
    expect(same.agent.currentVersion).toBe(1);

    const v2 = await agents.update(orgId, agent.id, owner.id, {
      definition: def({ instructions: "v2" }),
    });
    expect(v2.agent.currentVersion).toBe(2);
    expect(v2.agent.definition.instructions).toBe("v2");
    expect((await agents.getVersion(agent.id, 1)).definition.instructions).toBe("v1");
    expect((await agents.getVersion(agent.id, 2)).definition.instructions).toBe("v2");
    expect((await agents.listVersions(agent.id)).map((v) => v.version)).toEqual([2, 1]);
    expect(await codeOf(agents.getVersion(agent.id, 3))).toBe("agent.not_found");

    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail", "target"])
      .where("org_id", "=", orgId)
      .where("action", "like", "agent.%")
      .orderBy("id")
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      "agent.created",
      "agent.updated",
      "agent.updated",
      "agent.updated",
    ]);
    expect(audits[3]?.detail).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(audits[0]?.target).toBe(agent.id);
  });

  it("兜底与主模型同一供应商 → warnings 含 fallback_same_provider（不拒绝）", async () => {
    const { orgId, owner } = await orgWith({});
    const same = await agents.create(orgId, owner.id, {
      definition: def({ fallback: { provider: "model-fake", model: "fake-2" } }),
      visibility: "private",
    });
    expect(same.warnings).toEqual(["fallback_same_provider"]);
    const other = await agents.create(orgId, owner.id, {
      definition: def({ fallback: { provider: "model-fake-b", model: "b-1" } }),
      visibility: "private",
    });
    expect(other.warnings).toEqual([]);
  });

  it("主模型或兜底不可解析 → agent.model_unavailable", async () => {
    const { orgId, owner } = await orgWith({});
    expect(
      await codeOf(
        agents.create(orgId, owner.id, {
          definition: def({ model: { provider: "model-fake", model: "nope" } }),
          visibility: "private",
        }),
      ),
    ).toBe("agent.model_unavailable");
    expect(
      await codeOf(
        agents.create(orgId, owner.id, {
          definition: def({ fallback: { provider: "missing", model: "x" } }),
          visibility: "private",
        }),
      ),
    ).toBe("agent.model_unavailable");
    const { agent } = await agents.create(orgId, owner.id, {
      definition: def(),
      visibility: "private",
    });
    expect(
      await codeOf(
        agents.update(orgId, agent.id, owner.id, {
          definition: def({ model: { provider: "model-fake-b", model: "b-9" } }),
        }),
      ),
    ).toBe("agent.model_unavailable");
  });

  it("访客不能创建；memberIds 必须是组织成员", async () => {
    const { orgId, guest, owner } = await orgWith({ guest: "guest" });
    expect(
      await codeOf(agents.create(orgId, guest.id, { definition: def(), visibility: "org" })),
    ).toBe("forbidden");
    const outsider = await account();
    expect(
      await codeOf(
        agents.create(orgId, owner.id, {
          definition: def(),
          visibility: "members",
          memberIds: [outsider.id],
        }),
      ),
    ).toBe("member.not_found");
  });
});

describe("AgentsService 可见性", () => {
  type Viewer = "owner" | "member" | "guest" | "listed" | "unlisted" | "other";
  const VIS = ["private", "org", "members"] as const;
  const EXPECTED: Record<(typeof VIS)[number], Record<Viewer, boolean>> = {
    private: {
      owner: true,
      member: false,
      guest: false,
      listed: false,
      unlisted: false,
      other: false,
    },
    org: { owner: true, member: true, guest: true, listed: true, unlisted: true, other: false },
    members: {
      owner: true,
      member: false,
      guest: false,
      listed: true,
      unlisted: false,
      other: false,
    },
  };
  const cases = VIS.flatMap((vis) =>
    (Object.keys(EXPECTED[vis]) as Viewer[]).map((v) => [vis, v, EXPECTED[vis][v]] as const),
  );

  it.each(cases)("visibility=%s，viewer=%s → 可见 %s", async (vis, viewer, visible) => {
    const o = await orgWith({
      author: "member",
      member: "member",
      guest: "guest",
      listed: "guest",
      unlisted: "member",
    });
    const other = await orgWith({ m: "member" });
    const { agent } = await agents.create(o.orgId, o.author.id, {
      definition: def(),
      visibility: vis,
      ...(vis === "members" && { memberIds: [o.listed.id] }),
    });
    const viewers: Record<Viewer, Account> = {
      owner: o.author,
      member: o.member,
      guest: o.guest,
      listed: o.listed,
      unlisted: o.unlisted,
      other: other.m,
    };
    const who = viewers[viewer].id;
    if (visible) {
      expect((await agents.get(o.orgId, agent.id, who)).id).toBe(agent.id);
    } else {
      expect(await codeOf(agents.get(o.orgId, agent.id, who))).toBe("agent.not_found");
    }
    const listed = (await agents.listVisible(o.orgId, who)).map((a: AgentView) => a.id);
    expect(listed.includes(agent.id)).toBe(visible);
  });

  it("members 可见性回显 memberIds；其他可见性为 null", async () => {
    const o = await orgWith({ a: "member" });
    const { agent } = await agents.create(o.orgId, o.owner.id, {
      definition: def(),
      visibility: "members",
      memberIds: [o.a.id],
    });
    expect(agent.memberIds).toEqual([o.a.id]);
    const up = await agents.update(o.orgId, agent.id, o.owner.id, { visibility: "org" });
    expect(up.agent.memberIds).toBeNull();
  });

  it("服务令牌视角（viewer = null）只看到 visibility=org 的 agent", async () => {
    const o = await orgWith({});
    const pub = await agents.create(o.orgId, o.owner.id, { definition: def(), visibility: "org" });
    await agents.create(o.orgId, o.owner.id, { definition: def(), visibility: "private" });
    expect((await agents.listVisible(o.orgId, null)).map((a) => a.id)).toEqual([pub.agent.id]);
  });

  it("软删除后不可见", async () => {
    const o = await orgWith({});
    const { agent } = await agents.create(o.orgId, o.owner.id, {
      definition: def(),
      visibility: "org",
    });
    await agents.softDelete(o.orgId, agent.id, o.owner.id);
    expect(await codeOf(agents.get(o.orgId, agent.id, o.owner.id))).toBe("agent.not_found");
    expect(await agents.listVisible(o.orgId, o.owner.id)).toEqual([]);
    expect(await codeOf(agents.softDelete(o.orgId, agent.id, o.owner.id))).toBe("agent.not_found");
  });
});

describe("AgentsService 修改权限（锁内复核）", () => {
  it("非负责人的 member 改别人的 agent → forbidden；admin 可以", async () => {
    const o = await orgWith({ author: "member", m: "member", adm: "admin" });
    const { agent } = await agents.create(o.orgId, o.author.id, {
      definition: def(),
      visibility: "org",
    });
    expect(await codeOf(agents.update(o.orgId, agent.id, o.m.id, { visibility: "private" }))).toBe(
      "forbidden",
    );
    expect(await codeOf(agents.softDelete(o.orgId, agent.id, o.m.id))).toBe("forbidden");
    const r = await agents.update(o.orgId, agent.id, o.adm.id, {
      definition: def({ name: "Renamed" }),
    });
    expect(r.agent.currentVersion).toBe(2);
    expect(r.agent.definition.name).toBe("Renamed");
  });

  it("负责人被移出组织后再改 → forbidden", async () => {
    const o = await orgWith({ author: "member" });
    const { agent } = await agents.create(o.orgId, o.author.id, {
      definition: def(),
      visibility: "org",
    });
    await members.remove(o.orgId, o.author.id, o.owner.id);
    expect(
      await codeOf(agents.update(o.orgId, agent.id, o.author.id, { visibility: "private" })),
    ).toBe("forbidden");
  });

  it("负责人被降为访客后不能再改；其他组织的 agent → agent.not_found", async () => {
    const o = await orgWith({ author: "member" });
    const other = await orgWith({});
    const { agent } = await agents.create(o.orgId, o.author.id, {
      definition: def(),
      visibility: "org",
    });
    await members.changeRole(o.orgId, o.author.id, "guest", o.owner.id);
    expect(
      await codeOf(agents.update(o.orgId, agent.id, o.author.id, { visibility: "private" })),
    ).toBe("forbidden");
    expect(
      await codeOf(agents.update(other.orgId, agent.id, other.owner.id, { visibility: "org" })),
    ).toBe("agent.not_found");
  });
});
