import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaHasPath } from "../../src/catalog/schema-path.js";

const has = (s: z.ZodTypeAny, p: string) => schemaHasPath(s, p === "" ? [] : p.split("."));

describe("schemaHasPath", () => {
  const endpoint = z.object({
    url: z.url().refine(() => true),
    headers: z.record(z.string(), z.string()).default({}),
    auth: z.object({ region: z.string().optional() }).optional(),
    mode: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    piped: z.string().pipe(z.string().min(1)),
  });

  it("对象字段、嵌套对象、记录的任意键、union 分支、pipe", () => {
    for (const p of [
      "",
      "url",
      "headers",
      "headers.X-Tenant",
      "auth.region",
      "mode.a",
      "mode.b",
      "piped",
    ]) {
      expect(has(endpoint, p), p).toBe(true);
    }
  });

  it("不存在的字段、叶子之下的路径、原型键", () => {
    for (const p of ["baseUrl", "url.host", "auth.token", "mode.c", "__proto__", "constructor"]) {
      expect(has(endpoint, p), p).toBe(false);
    }
  });

  it("strict 对象没有 catchall；catchall 允许任意键", () => {
    expect(has(z.object({ a: z.string() }).strict(), "b")).toBe(false);
    expect(has(z.object({ a: z.string() }).catchall(z.string()), "b")).toBe(true);
  });
});
