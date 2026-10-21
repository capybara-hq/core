import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CAPABILITIES,
  OBJECT_STORE_CAPABILITY,
  type ObjectStore,
  type PluginContext,
  type PluginStorage,
  parseCapability,
  validatePermissions,
} from "../src/index.js";

describe("object-store@1", () => {
  it("能力引用与登记：单选、中转（插件不得 requires）", () => {
    expect(OBJECT_STORE_CAPABILITY).toBe("object-store@1");
    const { name } = parseCapability(OBJECT_STORE_CAPABILITY);
    expect(CAPABILITIES[name]).toEqual({ cardinality: "single", brokered: true, orgScoped: false });
  });

  it("ObjectStore 的方法", () => {
    expectTypeOf<keyof ObjectStore>().toEqualTypeOf<
      "put" | "get" | "head" | "delete" | "deletePrefix" | "list" | "presignGet" | "presignPut"
    >();
  });
});

/** ObjectStore 的每个方法在第一个参数前加 orgId。 */
type WithOrg<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (orgId: string, ...a: A) => R : never;
};

describe("ctx.storage", () => {
  it("PluginStorage 与 ObjectStore 同形，每个方法多一个打头的 orgId", () => {
    expectTypeOf<PluginStorage>().toEqualTypeOf<WithOrg<ObjectStore>>();
    expectTypeOf<PluginContext["storage"]>().toEqualTypeOf<PluginStorage>();
  });

  it("permissions.storage 是布尔值", () => {
    expect(validatePermissions("p", { storage: true })).toEqual([]);
    expect(validatePermissions("p", { storage: "yes" })).not.toEqual([]);
  });
});
