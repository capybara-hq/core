import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SetupService } from "../../src/admin/setup.service.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { truncateTables } from "../helpers/db.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let accounts: AccountsService;
let orgs: OrgsService;
let setup: SetupService;

const PW = "correct horse battery";

function makeSetup(d: KernelDb): SetupService {
  const a = new AccountsService(d);
  return new SetupService(d, a, new OrgsService(d, new SettingsService(d), new ApiTokenService(d)));
}

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  accounts = new AccountsService(db);
  orgs = new OrgsService(db, new SettingsService(db), new ApiTokenService(db));
  setup = new SetupService(db, accounts, orgs);
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await pg.stop();
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events",
  );
});

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: ApiError) => e.code,
  );

describe("SetupService", () => {
  it("初始需要初始化；complete 后不再需要，账号是企业管理员且是组织 owner；再 complete → setup.already_completed", async () => {
    expect(await setup.status()).toEqual({ needsSetup: true });
    const { account, org } = await setup.complete({
      login: "root",
      password: PW,
      displayName: "Root",
      orgName: "Acme Inc",
    });
    expect(account.isEnterpriseAdmin).toBe(true);
    expect(org?.name).toBe("Acme Inc");
    expect(await setup.status()).toEqual({ needsSetup: false });
    const mine = await orgs.listForAccount(account.id);
    expect(mine.map((o) => [o.id, o.role])).toEqual([[org?.id, "owner"]]);
    const events = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id"])
      .where("action", "=", "deployment.setup_completed")
      .execute();
    expect(events).toEqual([
      { action: "deployment.setup_completed", actor_account_id: account.id },
    ]);
    expect(
      await codeOf(setup.complete({ login: "root2", password: PW, displayName: "Root 2" })),
    ).toBe("setup.already_completed");
  });

  it("不给 orgName 时只建账号", async () => {
    const r = await setup.complete({ login: "root", password: PW, displayName: "Root" });
    expect(r.org).toBeUndefined();
    expect(await orgs.listForAccount(r.account.id)).toEqual([]);
  });

  it("只有停用的企业管理员时仍需要初始化", async () => {
    const a = await accounts.createLocal({
      login: "old",
      password: PW,
      displayName: "Old",
      enterpriseAdmin: true,
    });
    await db.updateTable("accounts").set({ status: "disabled" }).where("id", "=", a.id).execute();
    expect(await setup.status()).toEqual({ needsSetup: true });
  });

  it("concurrent setup：两个独立连接池并发 complete → 恰好一个成功，企业管理员恰好 1 个", async () => {
    const rawA = createDb(pg.url, 2);
    const rawB = createDb(pg.url, 2);
    try {
      const [ra, rb] = await Promise.allSettled([
        makeSetup(kernelDb(rawA)).complete({ login: "first", password: PW, displayName: "A" }),
        makeSetup(kernelDb(rawB)).complete({ login: "second", password: PW, displayName: "B" }),
      ]);
      const ok = [ra, rb].filter((r) => r.status === "fulfilled");
      const failed = [ra, rb].filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason.code).toBe("setup.already_completed");
      expect(await accounts.countEnterpriseAdmins()).toBe(1);
      const n = await db
        .selectFrom("accounts")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .executeTakeFirstOrThrow();
      expect(Number(n.n)).toBe(1);
    } finally {
      await Promise.all([rawA.destroy(), rawB.destroy()]);
    }
  });

  it("建组织失败（orgName 为空串）→ 账号也不残留", async () => {
    expect(
      await codeOf(
        setup.complete({ login: "root", password: PW, displayName: "Root", orgName: "  " }),
      ),
    ).toBe("validation_failed");
    expect(
      await codeOf(
        setup.complete({ login: "root", password: PW, displayName: "Root", orgName: "" }),
      ),
    ).toBe("validation_failed");
    const rows = await db.selectFrom("accounts").select("id").execute();
    expect(rows).toEqual([]);
    expect(await setup.status()).toEqual({ needsSetup: true });
  });

  it("createEnterpriseAdmin：已初始化也能建；登录名已存在 → account.login_taken", async () => {
    await setup.complete({ login: "root", password: PW, displayName: "Root" });
    const a = await setup.createEnterpriseAdmin({
      login: "ops",
      password: PW,
      displayName: "Ops",
      email: "ops@example.com",
    });
    expect(a.isEnterpriseAdmin).toBe(true);
    expect(a.email).toBe("ops@example.com");
    expect(
      await codeOf(setup.createEnterpriseAdmin({ login: "OPS", password: PW, displayName: "X" })),
    ).toBe("account.login_taken");
  });
  it("createEnterpriseAdminIfNone: an existing active enterprise admin → undefined, nothing created", async () => {
    await setup.complete({ login: "root", password: PW, displayName: "Root" });
    expect(
      await setup.createEnterpriseAdminIfNone({ login: "ops", password: PW, displayName: "Ops" }),
    ).toBeUndefined();
    expect(await accounts.count()).toBe(1);
  });

  it("createEnterpriseAdminIfNone: none yet → creates an enterprise admin", async () => {
    const a = await setup.createEnterpriseAdminIfNone({
      login: "ops",
      password: PW,
      displayName: "Ops",
    });
    expect(a?.isEnterpriseAdmin).toBe(true);
    expect(await setup.status()).toEqual({ needsSetup: false });
  });

  it("createEnterpriseAdminIfNone: concurrent runs (and a concurrent web setup) → exactly one admin", async () => {
    const pools = [createDb(pg.url, 2), createDb(pg.url, 2), createDb(pg.url, 2)];
    try {
      const [a, b, c] = pools.map((r) => makeSetup(kernelDb(r)));
      const results = await Promise.allSettled([
        (a as SetupService).createEnterpriseAdminIfNone({
          login: "first",
          password: PW,
          displayName: "A",
        }),
        (b as SetupService).createEnterpriseAdminIfNone({
          login: "second",
          password: PW,
          displayName: "B",
        }),
        (c as SetupService).complete({ login: "third", password: PW, displayName: "C" }),
      ]);
      const created = results.filter((r) => r.status === "fulfilled" && r.value !== undefined);
      expect(created).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason.code).toBe("setup.already_completed");
      }
      expect(await accounts.countEnterpriseAdmins()).toBe(1);
      expect(await accounts.count()).toBe(1);
    } finally {
      await Promise.all(pools.map((r) => r.destroy()));
    }
  });
});
