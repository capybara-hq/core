import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  endpointCredentialIssues,
  endpointView,
  publicEndpoint,
} from "../../src/tools/endpoint.js";

describe("应用端点的通用处理", () => {
  it("`url` 与 `*Url` 字段都检查凭据样式的 query 与用户信息", () => {
    expect(
      endpointCredentialIssues({
        specUrl: "https://api.example.com/openapi.json?api_key=x",
        baseUrl: "https://u:p@api.example.com/v1",
        url: "https://mcp.example.com/mcp?token=y",
        specText: "https://u:p@not-a-url-field.example.com",
      }).map((i) => i.path),
    ).toEqual(["endpoint.specUrl", "endpoint.baseUrl", "endpoint.url"]);
    expect(endpointCredentialIssues({ specUrl: "https://api.example.com/o.json?v=2" })).toEqual([]);
  });

  it("给非管理员看的端点：URL 字段只留源（路径打码为「/…」，去掉 query 与用户信息），其余字段原样", () => {
    expect(
      publicEndpoint({
        specUrl: "https://u:p@api.example.com/tenants/acme/openapi.json?tenant=1#x",
        baseUrl: "https://api.example.com/v1?tenant=1",
        url: "https://mcp.example.com/",
        tokenUrl: "https://auth.example.com",
        operations: ["listPets"],
        headers: { "X-Tenant": "1" },
      }),
    ).toEqual({
      specUrl: "https://api.example.com/…",
      baseUrl: "https://api.example.com/…",
      url: "https://mcp.example.com",
      tokenUrl: "https://auth.example.com",
      operations: ["listPets"],
      headerNames: ["X-Tenant"],
    });
  });

  it("应用视图不回显 `*Text` 字段全文，只给字节数与 sha256（所有人）", () => {
    const text = "openapi: 3.1.0\ninfo: { title: é }";
    expect(endpointView({ specText: text, baseUrl: "https://api.example.com" })).toEqual({
      baseUrl: "https://api.example.com",
      specTextBytes: Buffer.byteLength(text, "utf8"),
      specTextSha256: createHash("sha256").update(text).digest("hex"),
    });
    expect(endpointView({ url: "https://x.example.com" })).toEqual({
      url: "https://x.example.com",
    });
  });
});
