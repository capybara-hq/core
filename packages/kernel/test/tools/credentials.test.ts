import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { createLogger } from "../../src/log.js";
import { CredentialMissing, Credentials } from "../../src/tools/credentials.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
// biome-ignore lint/suspicious/noExplicitAny: 测试库无表结构类型
let raw: Kysely<any>;
const lines: string[] = [];
const log = createLogger("info", { write: (l) => lines.push(l) });
let creds: Credentials;

const ORG = "org_cred_1";
const APP = "app_1";
const TOKEN = "tok_abcdefghijklmnop";

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(box.url, 5);
  creds = new Credentials(kernelDb(raw), createKeyring(randomBytes(32), []), log);
});
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});

const org = { kind: "org" } as const;
const user = (accountId: string) => ({ kind: "user", accountId }) as const;

describe("Credentials 静态认证注入", () => {
  it("bearer", async () => {
    await creds.setStatic(ORG, APP, org, { token: TOKEN });
    expect(await creds.injection(ORG, APP, { type: "bearer", ownership: "org" }, "a1")).toEqual({
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("api_key：header 与 query", async () => {
    await creds.setStatic(ORG, "app_k", org, { token: TOKEN });
    expect(
      await creds.injection(
        ORG,
        "app_k",
        { type: "api_key", ownership: "org", in: "header", name: "X-Api-Key" },
        "a1",
      ),
    ).toEqual({ headers: { "X-Api-Key": TOKEN } });
    expect(
      await creds.injection(
        ORG,
        "app_k",
        { type: "api_key", ownership: "org", in: "query", name: "key" },
        "a1",
      ),
    ).toEqual({ headers: {}, query: { key: TOKEN } });
  });

  it("basic", async () => {
    await creds.setStatic(ORG, "app_b", org, { username: "alice", password: "pw-0123456789" });
    const inj = await creds.injection(ORG, "app_b", { type: "basic", ownership: "org" }, "a1");
    expect(inj.headers.Authorization).toBe(
      `Basic ${Buffer.from("alice:pw-0123456789").toString("base64")}`,
    );
  });

  it("headers：按配置的名字取值；缺名字视为缺凭据", async () => {
    await creds.setStatic(ORG, "app_h", org, { headers: { "X-A": "value-aaaaaaaaaaaa" } });
    expect(
      await creds.injection(
        ORG,
        "app_h",
        { type: "headers", ownership: "org", names: ["X-A"] },
        "a1",
      ),
    ).toEqual({ headers: { "X-A": "value-aaaaaaaaaaaa" } });
    await expect(
      creds.injection(
        ORG,
        "app_h",
        { type: "headers", ownership: "org", names: ["X-A", "X-B"] },
        "a1",
      ),
    ).rejects.toBeInstanceOf(CredentialMissing);
  });

  it("none 不需要凭据", async () => {
    expect(await creds.injection(ORG, "app_none", { type: "none" }, "a1")).toEqual({ headers: {} });
  });

  it("个人凭据互相隔离，org 凭据不被个人应用读取", async () => {
    const auth = { type: "bearer", ownership: "personal" } as const;
    await creds.setStatic(ORG, "app_p", user("u1"), { token: "personal-token-u1-xxxx" });
    expect((await creds.injection(ORG, "app_p", auth, "u1")).headers.Authorization).toBe(
      "Bearer personal-token-u1-xxxx",
    );
    await expect(creds.injection(ORG, "app_p", auth, "u2")).rejects.toBeInstanceOf(
      CredentialMissing,
    );
    expect(await creds.status(ORG, "app_p", "u1")).toBe("connected");
    expect(await creds.status(ORG, "app_p", "u2")).toBe("missing");
    // org 凭据存在也不能顶替个人
    await creds.setStatic(ORG, "app_p", org, { token: "org-token-yyyyyyyyyy" });
    await expect(creds.injection(ORG, "app_p", auth, "u2")).rejects.toBeInstanceOf(
      CredentialMissing,
    );
  });

  it("缺凭据抛 CredentialMissing：带 appId 与归属，不带值", async () => {
    const err = await creds
      .injection(ORG, "app_nothing", { type: "bearer", ownership: "personal" }, "u9")
      .catch((e) => e);
    expect(err).toBeInstanceOf(CredentialMissing);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("credential.missing");
    expect(err.appId).toBe("app_nothing");
    expect(err.ownership).toBe("personal");
    expect(err.message).toBe("No credential configured for app app_nothing (personal)");
  });

  it("clear 之后缺失", async () => {
    await creds.setStatic(ORG, "app_c", user("u1"), { token: TOKEN });
    await creds.clear(ORG, "app_c", user("u1"));
    expect(await creds.status(ORG, "app_c", "u1")).toBe("missing");
  });

  it("读出的值登记打码；密文落库、明文不落库", async () => {
    const token = "redact-me-token-123456";
    await creds.setStatic(ORG, "app_r", org, { token });
    await creds.injection(ORG, "app_r", { type: "bearer", ownership: "org" }, "a1");
    lines.length = 0;
    log.info("outgoing", { header: `Bearer ${token}` });
    expect(lines.join("\n")).toContain("[REDACTED]");
    expect(lines.join("\n")).not.toContain(token);

    const row = await raw
      .withSchema("capybara")
      .selectFrom("secrets")
      .selectAll()
      .where("org_id", "=", ORG)
      .where("key", "=", "credentials:app:app_r:org")
      .executeTakeFirstOrThrow();
    expect(row.namespace).toBe("kernel");
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(token);
  });
});
