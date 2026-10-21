import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://x" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
};

describe("配置 sandbox", () => {
  it("默认值", () => {
    const c = KernelConfigSchema.parse(base);
    expect(c.sandbox.image).toBeTypeOf("string");
    expect(c.sandbox.lockWaitSeconds).toBe(30);
    expect(c.sandbox.limits).toEqual({
      cpu: 1,
      memoryMb: 2048,
      diskMb: 5120,
      maxCommandSeconds: 7200,
      suspendAfterIdleMinutes: 10,
      destroyAfterInactiveDays: 7,
      maxRunningMinutes: 120,
      egress: "allowlist",
      allowHosts: [
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
        "github.com",
        "objects.githubusercontent.com",
        "deb.debian.org",
      ],
    });
  });

  it("allowHosts 每项用 validateAllowHost 校验：IP、单段名、带协议 / 端口都拒绝", () => {
    for (const bad of [
      "10.0.0.1",
      "localhost",
      "https://github.com",
      "github.com:443",
      "a.local",
    ]) {
      const r = KernelConfigSchema.safeParse({
        ...base,
        sandbox: { limits: { allowHosts: [bad] } },
      });
      expect(r.success, bad).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("allowHosts");
    }
    const ok = KernelConfigSchema.parse({
      ...base,
      sandbox: { limits: { allowHosts: ["*.example.com"], egress: "none" } },
    });
    expect(ok.sandbox.limits.allowHosts).toEqual(["*.example.com"]);
    expect(ok.sandbox.limits.egress).toBe("none");
  });

  it("egress 只认 none / allowlist / open", () => {
    expect(
      KernelConfigSchema.safeParse({ ...base, sandbox: { limits: { egress: "all" } } }).success,
    ).toBe(false);
  });
});
