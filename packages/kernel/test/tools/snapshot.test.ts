import { describe, expect, it } from "vitest";
import { snapshot } from "../../src/tools/drift.js";

/** Ruling A21：连接器的 `connectorData`（路由等不透明数据）进快照与指纹，变化即漂移。 */
describe("快照里的 connectorData", () => {
  const tool = (connectorData?: unknown) => ({
    name: "get",
    description: "Get it.",
    inputSchema: { type: "object" },
    ...(connectorData !== undefined && { connectorData }),
  });

  it("对象形式的 connectorData 原样保留，参与 spec_hash", () => {
    const a = snapshot("x", [tool({ method: "get", path: "/a" })], false).rows[0];
    const b = snapshot("x", [tool({ method: "delete", path: "/a" })], false).rows[0];
    expect(a?.spec.connectorData).toEqual({ method: "get", path: "/a" });
    expect(a?.specHash).not.toBe(b?.specHash);
  });

  it("不是对象的 connectorData 丢弃（不影响指纹）", () => {
    const plain = snapshot("x", [tool()], false).rows[0];
    const bad = snapshot("x", [tool("nope")], false).rows[0];
    expect(bad?.spec.connectorData).toBeUndefined();
    expect(bad?.specHash).toBe(plain?.specHash);
  });
});
