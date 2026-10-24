import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EXTENSION_POINTS,
  type ExtensionContext,
  type ExtensionStorage,
  OBJECT_STORE_EXTENSION_POINT,
  type ObjectStore,
  type PresignedUpload,
  type PresignGetOptions,
  parseExtensionPoint,
  validatePermissions,
} from "../src/index.js";

describe("object-store@1", () => {
  it("能力引用与登记：单选、中转（插件不得 requires）", () => {
    expect(OBJECT_STORE_EXTENSION_POINT).toBe("object-store@1");
    const { name } = parseExtensionPoint(OBJECT_STORE_EXTENSION_POINT);
    expect(EXTENSION_POINTS[name]).toEqual({
      cardinality: "single",
      brokered: true,
      orgScoped: false,
    });
  });

  it("presignGet 的选项：disposition 与 responseContentType（两种 storage 同一形状）", () => {
    expectTypeOf<PresignGetOptions>().toEqualTypeOf<{
      ttlSeconds: number;
      downloadName?: string;
      disposition?: "attachment" | "inline";
      responseContentType?: string;
    }>();
    expectTypeOf<Parameters<ObjectStore["presignGet"]>[1]>().toEqualTypeOf<PresignGetOptions>();
    expectTypeOf<
      Parameters<ExtensionStorage["presignGet"]>[2]
    >().toEqualTypeOf<PresignGetOptions>();
  });

  it("ObjectStore 的方法", () => {
    expectTypeOf<keyof ObjectStore>().toEqualTypeOf<
      "put" | "get" | "head" | "delete" | "deletePrefix" | "list" | "presignGet" | "presignPut"
    >();
  });

  it("presignPut 返回 PUT 或 POST（POST 带表单字段，存储端能限制大小）", () => {
    expectTypeOf<Awaited<ReturnType<ObjectStore["presignPut"]>>>().toEqualTypeOf<PresignedUpload>();
    expectTypeOf<PresignedUpload["method"]>().toEqualTypeOf<"PUT" | "POST">();
    expectTypeOf<PresignedUpload["fields"]>().toEqualTypeOf<Record<string, string> | undefined>();
  });
});

/** ObjectStore 的每个方法在第一个参数前加 orgId。 */
type WithOrg<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (orgId: string, ...a: A) => R : never;
};

describe("ctx.storage", () => {
  it("ExtensionStorage 与 ObjectStore 同形，每个方法多一个打头的 orgId", () => {
    expectTypeOf<ExtensionStorage>().toEqualTypeOf<WithOrg<ObjectStore>>();
    expectTypeOf<ExtensionContext["storage"]>().toEqualTypeOf<ExtensionStorage>();
  });

  it("permissions.storage 是布尔值", () => {
    expect(validatePermissions("p", { storage: true })).toEqual([]);
    expect(validatePermissions("p", { storage: "yes" })).not.toEqual([]);
  });
});
