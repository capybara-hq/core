import { describe, expect, it } from "vitest";
import { endpointCredentialIssues, publicEndpoint } from "../../src/tools/endpoint.js";

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

  it("给非管理员看的端点：URL 字段去掉 query 与用户信息，其余字段原样", () => {
    expect(
      publicEndpoint({
        specUrl: "https://api.example.com/openapi.json?tenant=1#x",
        baseUrl: "https://api.example.com/v1?tenant=1",
        operations: ["listPets"],
        headers: { "X-Tenant": "1" },
      }),
    ).toEqual({
      specUrl: "https://api.example.com/openapi.json",
      baseUrl: "https://api.example.com/v1",
      operations: ["listPets"],
      headerNames: ["X-Tenant"],
    });
  });
});
