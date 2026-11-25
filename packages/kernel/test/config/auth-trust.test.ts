import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

/**
 * Login methods and trusted tenants are a deployment setting (login extensions spec §1), no
 * longer startup config: a deployment that still sets the old keys fails at startup naming them.
 */
describe("removed auth login keys", () => {
  for (const key of ["loginSources", "trustedIdentitySources"]) {
    it(`auth.${key} is refused`, () => {
      const r = KernelConfigSchema.safeParse({ ...base, auth: { [key]: [] } });
      expect(r.success).toBe(false);
      const issue = r.error?.issues[0];
      expect(issue?.code).toBe("unrecognized_keys");
      expect(issue?.path).toEqual(["auth"]);
      expect((issue as { keys?: string[] } | undefined)?.keys).toEqual([key]);
    });
  }
});
