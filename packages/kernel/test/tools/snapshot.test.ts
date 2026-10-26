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

/** UI refresh B: `title` / `keyArgs` are display only — kept in the snapshot, outside the hash. */
describe("display-only title and keyArgs in the snapshot", () => {
  const tool = (extra: Record<string, unknown> = {}) => ({
    name: "search",
    description: "Search messages.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    ...extra,
  });

  it("keeps a valid title and keyArgs without changing spec_hash", () => {
    const plain = snapshot("x", [tool()], false).rows[0];
    const titled = snapshot("x", [tool({ title: "Search messages", keyArgs: ["query"] })], false)
      .rows[0];
    expect(titled?.spec.title).toBe("Search messages");
    expect(titled?.spec.keyArgs).toEqual(["query"]);
    expect(titled?.specHash).toBe(plain?.specHash);
    expect(titled?.issue).toBeNull();
  });

  it("drops an invalid title or keyArgs instead of disabling the tool", () => {
    const row = snapshot("x", [tool({ title: "x".repeat(81), keyArgs: ["nope"] })], false).rows[0];
    expect(row?.spec).not.toHaveProperty("title");
    expect(row?.spec).not.toHaveProperty("keyArgs");
    expect(row?.issue).toBeNull();
    const odd = snapshot("x", [tool({ title: 42, keyArgs: "query" })], false).rows[0];
    expect(odd?.spec).not.toHaveProperty("title");
    expect(odd?.spec).not.toHaveProperty("keyArgs");
  });
});
