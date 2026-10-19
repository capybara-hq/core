import { fileURLToPath } from "node:url";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  countLines,
  renderResult,
  resolveOutputRefs,
  spillIfLarge,
  ToolOutputs,
} from "../../src/tools/outputs.js";
import { truncateTables } from "../helpers/db.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let outputs: ToolOutputs;
let seed: Awaited<ReturnType<typeof seedConversation>>;
let other: Awaited<ReturnType<typeof seedConversation>>;

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => base;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  outputs = new ToolOutputs(db, config);
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  seed = await seedConversation(raw);
  other = await seedConversation(raw);
});

const mineScope = () => ({ orgId: seed.orgId, conversationId: seed.conversationId });
const otherScope = () => ({ orgId: other.orgId, conversationId: other.conversationId });

const save = (orgId: string, conversationId: string, content: string) =>
  outputs.save({ orgId, conversationId, callId: "c1", content });

/** 与 seed 同组织、同 agent 的另一个会话。 */
async function siblingConversation(): Promise<string> {
  const id = `sib-${seed.conversationId}`;
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${id}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId})`.execute(raw);
  return id;
}

describe("ToolOutputs", () => {
  it("save 记录字符数、行数与到期时间（outputRetentionDays）；load 只读本组织本会话、未过期的", async () => {
    const out = await save(seed.orgId, seed.conversationId, "a\nb\nc");
    expect(out).toMatchObject({ sizeChars: 5, lineCount: 3 });
    const row = await db
      .selectFrom("tool_outputs")
      .selectAll()
      .where("id", "=", out.id)
      .executeTakeFirstOrThrow();
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(await outputs.load(mineScope(), out.id)).toBe("a\nb\nc");
    expect(await outputs.load(otherScope(), out.id)).toBeNull();
    // 同组织的另一个会话也读不到（存档只属于产生它的会话）
    const sibling = await siblingConversation();
    expect(await outputs.load({ orgId: seed.orgId, conversationId: sibling }, out.id)).toBeNull();
    // 组织不符时即使会话 id 对也读不到
    expect(
      await outputs.load({ orgId: other.orgId, conversationId: seed.conversationId }, out.id),
    ).toBeNull();
    await db
      .updateTable("tool_outputs")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", out.id)
      .execute();
    expect(await outputs.load(mineScope(), out.id)).toBeNull();
  });

  it("countLines", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\n")).toBe(3);
  });
});

describe("resolveOutputRefs", () => {
  it("任意位置（嵌套对象、数组）的 {$output} 替换为存档全文；多一个键的对象原样保留", async () => {
    const a = await save(seed.orgId, seed.conversationId, "FULL-A");
    const b = await save(seed.orgId, seed.conversationId, "FULL-B");
    const load = (id: string) => outputs.load(mineScope(), id);
    const input = {
      top: { $output: a.id },
      nested: { list: [1, { $output: b.id }, { deep: [{ $output: a.id }] }] },
      notRef: { $output: a.id, extra: true },
      keep: "x",
    };
    expect(await resolveOutputRefs(input, load)).toEqual({
      top: "FULL-A",
      nested: { list: [1, "FULL-B", { deep: ["FULL-A"] }] },
      notRef: { $output: a.id, extra: true },
      keep: "x",
    });
    expect(await resolveOutputRefs({ $output: a.id }, load)).toBe("FULL-A");
    // 原对象不被修改
    expect(input.top).toEqual({ $output: a.id });
  });

  it("不存在 / 跨组织 / 过期 → ToolError，消息点名 id；id 不是字符串 → ToolError", async () => {
    const mine = await save(seed.orgId, seed.conversationId, "secret");
    const loadOther = (id: string) => outputs.load(otherScope(), id);
    await expect(resolveOutputRefs({ x: { $output: mine.id } }, loadOther)).rejects.toThrow(
      ToolError,
    );
    await expect(resolveOutputRefs({ x: { $output: mine.id } }, loadOther)).rejects.toThrow(
      `Output ${mine.id} not found or expired`,
    );
    await expect(
      resolveOutputRefs({ $output: "nope" }, (id) => outputs.load(mineScope(), id)),
    ).rejects.toThrow("Output nope not found or expired");
    await expect(
      resolveOutputRefs({ $output: 42 }, (id) => outputs.load(mineScope(), id)),
    ).rejects.toThrow(ToolError);
  });
});

describe("renderResult", () => {
  it("文本块拼接；图片 → 类型与字节数说明；resource_link → [resource <uri>]；记录内容类型", () => {
    const png = Buffer.alloc(10, 1).toString("base64");
    const r = renderResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: png },
        { type: "resource_link", uri: "file:///a.txt", name: "a" },
        { type: "text", text: "bye" },
      ],
    });
    expect(r.text).toBe("hello\n[image image/png, 10 bytes]\n[resource file:///a.txt]\nbye");
    expect(r.contentTypes).toEqual(["text", "image", "resource_link"]);
    expect(r.isError).toBe(false);
    expect(renderResult({ content: [{ type: "text", text: "boom" }], isError: true }).isError).toBe(
      true,
    );
  });

  it("畸形结果（不是对象、content 不是数组、未知块）给出说明而不是抛错", () => {
    expect(renderResult(null)).toMatchObject({ isError: true });
    expect(renderResult(null).text).toMatch(/malformed result/);
    expect(renderResult({ content: "x" })).toMatchObject({ isError: true });
    expect(renderResult({ content: [{ type: "audio", data: "..." }] }).text).toBe(
      "[unsupported content audio]",
    );
    expect(renderResult({ content: [] }).text).toBe("(no output)");
  });
});

describe("spillIfLarge", () => {
  it("不超过阈值原样返回；超过 → 存档并给预览 + 截断说明（含 id、字符数、行数）", async () => {
    const opts = { spillChars: 20, previewChars: 5 };
    const saveFn = (content: string) => save(seed.orgId, seed.conversationId, content);
    expect(await spillIfLarge("short", opts, saveFn)).toEqual({ content: "short" });
    const big = "0123456789\n0123456789\n0123456789";
    const r = await spillIfLarge(big, opts, saveFn);
    expect(r.outputId).toBeDefined();
    const id = r.outputId as string;
    expect(r.content).toBe(
      `01234\n…\n[Output truncated: ${big.length} chars, 3 lines. Full output id: ${id}. ` +
        `Use read_tool_output to page through it, or pass {"$output":"${id}"} as a tool argument.]`,
    );
    expect(await outputs.load(mineScope(), id)).toBe(big);
  });
});
