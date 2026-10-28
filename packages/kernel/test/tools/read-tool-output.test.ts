import { fileURLToPath } from "node:url";
import { type ToolCallContext, ToolError, type ToolResult } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { readToolOutputTool } from "../../src/tools/builtins/read-tool-output.js";
import { ToolOutputs } from "../../src/tools/outputs.js";
import { validateInput } from "../../src/tools/validate.js";
import { truncateTables } from "../helpers/db.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/** Task 10：内置工具 `read_tool_output`（按行分页读取输出存档，只读本组织、未过期的）。 */

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let seed: Awaited<ReturnType<typeof seedConversation>>;
let other: Awaited<ReturnType<typeof seedConversation>>;

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
let cfg: KernelConfig = base;
const config = (): KernelConfig => cfg;
const withMaxRead = (n: number) => {
  cfg = { ...base, tools: { ...base.tools, maxResultReadChars: n } };
};

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});
beforeEach(async () => {
  cfg = base;
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  seed = await seedConversation(raw);
  other = await seedConversation(raw);
});

const outputs = () => new ToolOutputs(db, config);
const tool = () => readToolOutputTool({ outputs: outputs(), config });

const ctxFor = (orgId: string): ToolCallContext => ({
  orgId,
  accountId: seed.accountId,
  agentId: seed.agentId,
  conversationId: seed.conversationId,
  callId: "c1",
  signal: new AbortController().signal,
});

async function save(content: string, orgId = seed.orgId): Promise<string> {
  const out = await outputs().save({
    orgId,
    conversationId: orgId === seed.orgId ? seed.conversationId : other.conversationId,
    callId: "c0",
    content,
  });
  return out.id;
}

async function read(input: Record<string, unknown>, orgId = seed.orgId): Promise<string> {
  const r = (await tool().run(input, ctxFor(orgId))) as ToolResult;
  expect(r.isError ?? false).toBe(false);
  const block = r.content[0];
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
}

const lines = (n: number, f: (i: number) => string = (i) => `line${i}`) =>
  Array.from({ length: n }, (_, i) => f(i)).join("\n");

describe("read_tool_output", () => {
  it("声明：名字、只读、默认 allow；参数校验", () => {
    const t = tool();
    expect(t.spec.name).toBe("read_tool_output");
    expect(t.defaultPolicy).toBe("allow");
    expect(t.spec.annotations?.readOnlyHint).toBe(true);
    expect(validateInput("read_tool_output", t.spec, { id: "x" })).toBeNull();
    expect(
      validateInput("read_tool_output", t.spec, { id: "x", offset: 3, limit: 10, charOffset: 5 }),
    ).toBeNull();
    expect(validateInput("read_tool_output", t.spec, {})).toContain("id");
    expect(validateInput("read_tool_output", t.spec, { id: "x", offset: -1 })).not.toBeNull();
    expect(validateInput("read_tool_output", t.spec, { id: "x", limit: 0 })).not.toBeNull();
    expect(validateInput("read_tool_output", t.spec, { id: "x", offset: 1.5 })).not.toBeNull();
  });

  it("按行分页：默认从第 0 行读 200 行；offset / limit；结尾写行范围", async () => {
    const id = await save(lines(250));
    const first = await read({ id });
    expect(first).toBe(`${lines(200)}\n[Lines 0–199 of 250]`);
    const rest = await read({ id, offset: 200 });
    expect(rest).toBe(`${lines(50, (i) => `line${i + 200}`)}\n[Lines 200–249 of 250]`);
    expect(await read({ id, offset: 3, limit: 2 })).toBe("line3\nline4\n[Lines 3–4 of 250]");
  });

  it("单次返回不超过 maxResultReadChars：按整行截止，下一次从下一行读", async () => {
    withMaxRead(10);
    const id = await save(lines(5, () => "aaaa"));
    expect(await read({ id })).toBe("aaaa\naaaa\n[Lines 0–1 of 5]");
    expect(await read({ id, offset: 2 })).toBe("aaaa\naaaa\n[Lines 2–3 of 5]");
  });

  it("某一行超过上限时按字符切，写明续读位置；续读到行尾后接着读后面的行", async () => {
    withMaxRead(10);
    const long = "x".repeat(12) + "y".repeat(13);
    const id = await save(`short\n${long}\nend`);
    // 已有整行时不切下一行
    expect(await read({ id })).toBe("short\n[Lines 0–0 of 3]");
    expect(await read({ id, offset: 1 })).toBe(
      "xxxxxxxxxx\n[Line 1 continues; call again with offset=1 charOffset=10]\n[Lines 1–1 of 3]",
    );
    expect(await read({ id, offset: 1, charOffset: 10 })).toBe(
      "xxyyyyyyyy\n[Line 1 continues; call again with offset=1 charOffset=20]\n[Lines 1–1 of 3]",
    );
    expect(await read({ id, offset: 1, charOffset: 20 })).toBe("yyyyy\nend\n[Lines 1–2 of 3]");
  });

  it("offset 越界、charOffset 越界 → 明确错误", async () => {
    const id = await save("a\nbb");
    await expect(tool().run({ id, offset: 2 }, ctxFor(seed.orgId))).rejects.toThrow(
      /Offset 2 is past the end of output .* \(2 lines\)/,
    );
    await expect(
      tool().run({ id, offset: 1, charOffset: 5 }, ctxFor(seed.orgId)),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("只能读本组织的存档；不存在 / 过期 → 明确错误", async () => {
    const id = await save("secret");
    const err = await tool()
      .run({ id }, ctxFor(other.orgId))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe(
      `Output ${id} not found or expired. Run the tool that produced it again to get a new output id.`,
    );
    await db
      .updateTable("tool_outputs")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", id)
      .execute();
    await expect(tool().run({ id }, ctxFor(seed.orgId))).rejects.toThrow(/not found or expired/);
    await expect(tool().run({ id: "nope" }, ctxFor(seed.orgId))).rejects.toThrow(
      /Output nope not found or expired/,
    );
  });

  it("只能读本会话的存档：同组织别的会话 → not found", async () => {
    const id = await save("conversation scoped");
    const sibling = `sib-${seed.conversationId}`;
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${sibling}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId})`.execute(raw);
    await expect(
      tool().run({ id }, { ...ctxFor(seed.orgId), conversationId: sibling }),
    ).rejects.toThrow(`Output ${id} not found or expired`);
    expect(await read({ id })).toContain("conversation scoped");
  });
});
