import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDualReplicaHarness, type Harness } from "../src/dual-replica.js";
import { startTestPostgres, type TestContainer } from "../src/index.js";

/**
 * M1 验收：两个独立进程的内核副本共享 PG / Redis，请求严格交替落在两个副本上。
 * 覆盖 初始化 → 建组织 → 邀请注册 → 按角色鉴权 → 跨副本即时生效的角色变更 / 登出 / 限流 → 并发初始化。
 */

let pgc: TestContainer;
const harnesses: Harness[] = [];

beforeAll(async () => {
  pgc = await startTestPostgres();
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

afterAll(async () => {
  await pgc?.stop();
});

async function harness(): Promise<Harness> {
  const h = await createDualReplicaHarness({
    extensions: [],
    pgUrl: pgc.url,
    // 测试走明文 http：关掉 Cookie 的 Secure 属性，与本地试用一致
    config: { auth: { cookieSecure: false } },
  });
  harnesses.push(h);
  return h;
}

/** 简单 Cookie 罐：只记 name=value，不区分 Path；空值 / `Max-Age=0` / 已过期视为删除。 */
class Jar {
  readonly cookies = new Map<string, string>();

  store(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const lower = attrs.map((a) => a.trim().toLowerCase());
      const expires = lower.find((a) => a.startsWith("expires="));
      const removed =
        value === "" ||
        lower.includes("max-age=0") ||
        (expires !== undefined && Date.parse(expires.slice(8)) <= Date.now());
      if (removed) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string | undefined {
    return this.cookies.size === 0
      ? undefined
      : [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clone(): Jar {
    const j = new Jar();
    for (const [k, v] of this.cookies) j.cookies.set(k, v);
    return j;
  }
}

/** 以 Cookie 罐身份发请求（JSON body，自动带 CSRF 头），收下响应的 set-cookie。 */
async function call(
  h: Harness,
  jar: Jar | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; setCookie: string[] }> {
  const cookie = jar?.header();
  const res = await h.request(path, {
    method,
    headers: {
      "x-capybara-csrf": "1",
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(cookie !== undefined && { cookie }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  jar?.store(res);
  const text = await res.text();
  return {
    status: res.status,
    json: text === "" ? {} : (JSON.parse(text) as never),
    setCookie: res.headers.getSetCookie(),
  };
}

const errorCode = (json: Record<string, unknown>) =>
  (json.error as { code?: string } | undefined)?.code;

describe("M1 双副本端到端验收", () => {
  it("初始化 → 组织 → 邀请注册 → 角色鉴权 → 跨副本的角色变更 / 登出 / 限流", async () => {
    const h = await harness();
    const admin = new Jar();
    const alice = new Jar();
    const bob = new Jar();

    // 1. 尚未初始化
    const s0 = await call(h, undefined, "GET", "/api/v1/setup");
    expect(s0.status).toBe(200);
    expect(s0.json).toEqual({ needsSetup: true });

    // 2. 初始化：建企业管理员 + 组织 Research，直接登录
    const s1 = await call(h, admin, "POST", "/api/v1/setup", {
      login: "root",
      password: "correct horse battery staple",
      displayName: "Root",
      orgName: "Research",
    });
    expect(s1.status).toBe(201);
    expect(admin.cookies.has("cap_at")).toBe(true);
    expect(admin.cookies.has("cap_rt")).toBe(true);
    // harness 的 config 透传生效：明文 http 下的 Cookie 不带 Secure
    expect(s1.setCookie.length).toBeGreaterThan(0);
    for (const c of s1.setCookie) expect(c.toLowerCase()).not.toMatch(/;\s*secure/);

    // 3. 另一副本上看得到组织，角色 owner
    const orgs = await call(h, admin, "GET", "/api/v1/orgs");
    expect(orgs.status).toBe(200);
    const list = orgs.json.orgs as { id: string; name: string; role: string }[];
    const research = list.find((o) => o.name === "Research");
    expect(research?.role).toBe("owner");
    const orgId = research?.id as string;
    const rootId = (s1.json.account as { id: string }).id;

    // 4. 邀请 member，未登录凭邀请注册
    const inv = await call(h, admin, "POST", `/api/v1/orgs/${orgId}/invitations`, {
      role: "member",
    });
    expect(inv.status).toBe(201);
    const acc = await call(h, alice, "POST", `/api/v1/invitations/${inv.json.token}/accept`, {
      login: "alice",
      password: "alice-password-1",
      displayName: "Alice",
    });
    expect(acc.status).toBe(200);
    expect(alice.cookies.has("cap_at")).toBe(true);
    const aliceId = (acc.json.account as { id: string }).id;

    // 5. member 可读成员（2 人），不能改别人角色
    const members = await call(h, alice, "GET", `/api/v1/orgs/${orgId}/members`);
    expect(members.status).toBe(200);
    expect(members.json.members).toHaveLength(2);
    const denied = await call(h, alice, "PATCH", `/api/v1/orgs/${orgId}/members/${rootId}`, {
      role: "member",
    });
    expect(denied.status).toBe(403);

    // 6. 再邀请一个 member（bob），管理员把 alice 升为 admin；alice 的下一个请求（另一副本）即可改 bob 的角色
    const inv2 = await call(h, admin, "POST", `/api/v1/orgs/${orgId}/invitations`, {
      role: "member",
    });
    expect(inv2.status).toBe(201);
    const acc2 = await call(h, bob, "POST", `/api/v1/invitations/${inv2.json.token}/accept`, {
      login: "bob",
      password: "bob-password-1",
      displayName: "Bob",
    });
    expect(acc2.status).toBe(200);
    const bobId = (acc2.json.account as { id: string }).id;
    const promote = await call(h, admin, "PATCH", `/api/v1/orgs/${orgId}/members/${aliceId}`, {
      role: "admin",
    });
    expect(promote.status).toBe(200);
    const allowed = await call(h, alice, "PATCH", `/api/v1/orgs/${orgId}/members/${bobId}`, {
      role: "guest",
    });
    expect(allowed.status).not.toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.json).toEqual({ accountId: bobId, role: "guest" });

    // 7. alice 在一个副本登出，旧 cap_at 在另一个副本立即失效
    const stale = alice.clone();
    const out = await call(h, alice, "POST", "/api/v1/auth/logout");
    expect(out.status).toBe(204);
    const me = await call(h, stale, "GET", "/api/v1/me");
    expect(me.status).toBe(401);
    expect(errorCode(me.json)).toBe("auth.session_revoked");

    // 8. 交替副本 10 次错误登录，第 11 次被限流（计数在 Redis，跨副本累计）
    for (let i = 0; i < 10; i++) {
      const r = await call(h, undefined, "POST", "/api/v1/auth/login", {
        login: "alice",
        password: `wrong-${i}`,
      });
      expect(r.status).toBe(401);
    }
    const limited = await call(h, undefined, "POST", "/api/v1/auth/login", {
      login: "alice",
      password: "alice-password-1",
    });
    expect(limited.status).toBe(429);
    expect(errorCode(limited.json)).toBe("auth.rate_limited");
  }, 120_000);

  it("两个副本同时提交初始化：一个 201，另一个 409 setup.already_completed", async () => {
    const h = await harness();
    const body = { login: "root", password: "correct horse battery staple", displayName: "Root" };
    const results = await Promise.all([
      call(h, new Jar(), "POST", "/api/v1/setup", body),
      call(h, new Jar(), "POST", "/api/v1/setup", { ...body, login: "root2" }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = results.find((r) => r.status === 409);
    expect(errorCode(conflict?.json ?? {})).toBe("setup.already_completed");
  }, 120_000);
});
