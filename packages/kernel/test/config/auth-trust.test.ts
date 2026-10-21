import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

/** Ruling A19：受信任的身份源按租户配置，元素是完整的身份源键 `<插件名>:<租户 id>`。 */
describe("auth.trustedIdentitySources", () => {
  it("接受完整的身份源键", () => {
    const c = KernelConfigSchema.parse({
      ...base,
      auth: { trustedIdentitySources: ["lark:tenant_1", "fake-idp:t1"] },
    });
    expect(c.auth.trustedIdentitySources).toEqual(["lark:tenant_1", "fake-idp:t1"]);
  });

  it("只写插件名（不带租户）→ 拒绝，并说明要写成 <插件名>:<租户 id>", () => {
    const r = KernelConfigSchema.safeParse({
      ...base,
      auth: { trustedIdentitySources: ["lark"] },
    });
    expect(r.success).toBe(false);
    const issue = r.error?.issues[0];
    expect(issue?.path).toEqual(["auth", "trustedIdentitySources", 0]);
    expect(issue?.message).toMatch(/<plugin>:<tenantId>/);
  });

  it("租户为空或含空白、插件名不合规 → 拒绝", () => {
    for (const bad of ["lark:", ":t1", "lark:t 1", "Lark:t1", "local:x"]) {
      const r = KernelConfigSchema.safeParse({
        ...base,
        auth: { trustedIdentitySources: [bad] },
      });
      expect(r.success, bad).toBe(false);
    }
  });
});
