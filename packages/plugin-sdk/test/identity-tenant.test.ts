import { describe, expect, it } from "vitest";
import { type IdentitySourceTenant, validateTenantId } from "../src/index.js";

const slackDecl: IdentitySourceTenant = {
  label: { zh: "Slack 工作区 ID", en: "Slack workspace ID" },
  pattern: "^T[A-Z0-9]+$",
};
const googleDecl: IdentitySourceTenant = {
  label: { zh: "Google Workspace 主域名", en: "Google Workspace primary domain" },
  neverTrusted: ["consumer"],
};

describe("validateTenantId", () => {
  it("accepts a tenant matching the pattern", () => {
    expect(validateTenantId(slackDecl, "T0123ABCD")).toBe("ok");
    expect(validateTenantId(slackDecl, "  T0123ABCD ")).toBe("ok");
  });
  it("refuses a tenant not matching the pattern", () => {
    expect(validateTenantId(slackDecl, "E0123")).toBe("pattern");
  });
  it("refuses a never-trusted tenant", () => {
    expect(validateTenantId(googleDecl, "consumer")).toBe("never_trusted");
  });
  it("accepts anything non-blank without a declaration", () => {
    expect(validateTenantId(undefined, "anything")).toBe("ok");
    expect(validateTenantId(undefined, " ")).toBe("empty");
  });
  it("treats an invalid pattern as none", () => {
    expect(validateTenantId({ label: { zh: "x", en: "x" }, pattern: "[" }, "abc")).toBe("ok");
  });
});
