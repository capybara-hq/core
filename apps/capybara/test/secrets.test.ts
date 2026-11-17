import { randomBytes } from "node:crypto";
import {
  createDb,
  createKeyring,
  createSecrets,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  migrate,
} from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, runCliInProcess } from "./support/cli.js";

// Throwaway keys generated per run
const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const ORGS = ["org-a", "org-b", "org-c"];

let pg: TestContainer;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR });
  raw = createDb(pg.url, 2);
  const old = createSecrets(raw, createKeyring(oldKey, []), "cli-rewrap");
  for (const org of ORGS) await old.set(org, "token", `value-${org}`);
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await pg?.stop();
});

/** The test database, an unreachable Redis (the command must not use it) and the given keys. */
function testEnv(current: Buffer, previous: Buffer[]): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: current.toString("base64"),
    ...(previous.length > 0 && {
      CAPYBARA_MASTER_KEY_PREVIOUS: JSON.stringify(previous.map((k) => k.toString("base64"))),
    }),
  };
}

const masterKeyIds = async () =>
  (
    await raw
      .withSchema(KERNEL_SCHEMA)
      .selectFrom("org_data_keys")
      .select("master_key_id")
      .where("org_id", "in", ORGS)
      .execute()
  ).map((r) => r.master_key_id as string);

/** Neither key appears in any form in what the command wrote. */
function expectNoKey(out: string) {
  for (const k of [oldKey, newKey]) {
    expect(out).not.toContain(k.toString("base64"));
    expect(out).not.toContain(k.toString("hex"));
  }
}

describe("capybara secrets rewrap", () => {
  it("without the old key in masterKeyPrevious: exit 1 naming the org and key id, nothing written", async () => {
    const before = await masterKeyIds();
    const r = await runCliInProcess(["secrets", "rewrap"], testEnv(newKey, []));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("master key not in keyring");
    expect(r.stderr).toContain("org-a");
    expect(r.stderr).toContain(createKeyring(oldKey, []).currentId);
    expectNoKey(r.stdout + r.stderr);
    expect(await masterKeyIds()).toEqual(before);
  }, 60_000);

  it("rewraps every data key to the new key, prints counts and no key; a re-run does nothing", async () => {
    const env = testEnv(newKey, [oldKey]);
    const newId = createKeyring(newKey, []).currentId;
    const r = await runCliInProcess(["secrets", "rewrap"], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `rewrapped 3 org data key(s) and 0 initial password(s) to master key ${newId}`,
    );
    expect(r.stdout).toContain("wait auth.accessTokenTtlSeconds, then remove masterKeyPrevious");
    expectNoKey(r.stdout + r.stderr);
    expect(await masterKeyIds()).toEqual([newId, newId, newId]);
    // the new key alone reads every value
    const onlyNew = createSecrets(raw, createKeyring(newKey, []), "cli-rewrap");
    for (const org of ORGS) expect(await onlyNew.get(org, "token")).toBe(`value-${org}`);

    const again = await runCliInProcess(["secrets", "rewrap"], env);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("rewrapped 0 org data key(s) and 0 initial password(s)");
    expectNoKey(again.stdout + again.stderr);
  }, 60_000);

  it("an unknown secrets command is a usage error (exit 2)", async () => {
    const r = await runCliInProcess(["secrets", "rotate"], testEnv(newKey, []));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown secrets command "rotate"');
  }, 60_000);
});
