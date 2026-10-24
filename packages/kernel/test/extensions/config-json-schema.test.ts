import { secret } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configToJsonSchema } from "../../src/extensions/config-json-schema.js";

type Props = { properties: Record<string, Record<string, unknown>> };

describe("configToJsonSchema", () => {
  it("普通对象转成 JSON Schema，必填与默认值保留", () => {
    const js = configToJsonSchema(
      z.object({ appId: z.string(), n: z.number().default(3), tags: z.array(z.string()) }),
    );
    expect(js.type).toBe("object");
    expect(js.required).toEqual(["appId", "tags"]);
    expect((js as unknown as Props).properties.n?.default).toBe(3);
  });

  it("secret 字段（含可选与嵌套）带 x-secret 且不残留 secret 元数据键", () => {
    const js = configToJsonSchema(
      z.object({
        appSecret: secret(z.string()),
        webhook: z.object({ token: secret(z.string()).optional(), path: z.string() }),
      }),
    ) as unknown as Props;
    expect(js.properties.appSecret?.["x-secret"]).toBe(true);
    expect(js.properties.appSecret).not.toHaveProperty("secret");
    const wh = js.properties.webhook?.properties as Record<string, Record<string, unknown>>;
    expect(wh.token?.["x-secret"]).toBe(true);
    expect(wh.token).not.toHaveProperty("secret");
    expect(wh.path).not.toHaveProperty("x-secret");
  });

  it("无法表达的类型降级为 {} 并标注 x-unsupported，不抛错", () => {
    const js = configToJsonSchema(
      z.object({ when: z.date(), big: z.bigint(), ok: z.string() }),
    ) as unknown as Props;
    expect(js.properties.when).toEqual({ "x-unsupported": true });
    expect(js.properties.big).toEqual({ "x-unsupported": true });
    expect(js.properties.ok).toEqual({ type: "string" });
  });

  it("不带 $schema 键（嵌入 API 响应）", () => {
    expect(configToJsonSchema(z.object({}))).not.toHaveProperty("$schema");
  });

  it("密钥字段不输出 default / enum / const（两种 default 写法与 optional 包装）", () => {
    const js = configToJsonSchema(
      z.object({
        a: secret(z.string()).default("S3CRET"),
        b: secret(z.string().default("S4")),
        c: secret(z.string()).optional().default("S5"),
        d: secret(z.enum(["S6", "S7"])),
        e: z.string().default("plain"),
      }),
    ) as unknown as Props;
    for (const k of ["a", "b", "c", "d"]) {
      expect(js.properties[k]?.["x-secret"]).toBe(true);
      for (const w of ["default", "examples", "const", "enum"]) {
        expect(js.properties[k]).not.toHaveProperty(w);
      }
    }
    expect(JSON.stringify(js)).not.toMatch(/S3CRET|S4|S5|S6|S7/);
    expect(js.properties.e?.default).toBe("plain");
  });

  it("密钥对象 / 数组的所有后代同样不输出取值关键字（含名为 default / enum 的属性）", () => {
    const js = configToJsonSchema(
      z.object({
        obj: secret(
          z.object({
            a: z.string().default("NESTDEF"),
            b: z.enum(["NESTENUM1", "NESTENUM2"]),
            c: z.literal("NESTCONST"),
            default: z.string().default("PROPDEF"),
            enum: z.object({ deep: z.string().default("DEEPDEF") }),
          }),
        ),
        arr: secret(z.array(z.string().default("ITEMDEF"))),
        open: z.object({ default: z.string().default("PUBLICDEF") }),
      }),
    );
    const text = JSON.stringify(js);
    expect(text).not.toMatch(/NEST|PROPDEF|DEEPDEF|ITEMDEF/);
    const p = (js as unknown as Props).properties;
    const obj = p.obj?.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(obj)).toEqual(["a", "b", "c", "default", "enum"]);
    // 非密钥对象里名为 default 的属性保持原样（遍历到了、也没被误删）
    const open = p.open?.properties as Record<string, Record<string, unknown>>;
    expect(open.default?.default).toBe("PUBLICDEF");
  });
});
