import { renderCardAsText } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ChannelCardActions, type ChannelCardActionsDeps } from "../../src/channels/actions.js";
import { approvalCard, CARD_SUMMARY_MAX, commandCardText } from "../../src/channels/cards.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";

/**
 * The command review ask in IM (auto mode spec §5.4): the card's title, the reason and the held
 * command (a write: its path), its scope labels in zh and en, the text fallback, and the shared
 * anonymous guest account never deciding one.
 */

const EXPIRES = "2026-11-14T12:00:00.000Z";

const commandView = (over: Record<string, unknown> = {}) => ({
  id: "ca1",
  orgId: "o1",
  kind: "command",
  command: {
    deviceId: "d1",
    deviceName: "box",
    mode: "auto",
    kind: "command",
    command: `rm -rf ${"x".repeat(400)}`,
    rule: "rm:forced",
    reason: "Deletes files outside the workspace",
  },
  detail: null,
  git: null,
  toolKey: "Bash",
  toolName: "Bash",
  connector: null,
  extension: null,
  agent: { id: "ag1", name: "Helper" },
  input: {},
  summary: null,
  scopes: ["once", "session"],
  requestedFor: "a1",
  expiresAt: EXPIRES,
  status: "pending",
  decidedBy: null,
  denyReason: null,
  conversationPath: "/chat/c1",
  ...over,
});

const cardDeps = (v: object) =>
  ({
    db: {} as never,
    approvals: { describe: async () => v },
    registry: {
      builtinSpecs: () => {
        throw new Error("a command ask needs no tool display");
      },
      extensionToolSpecs: () => [],
    },
  }) as never;

describe("a command review ask card", () => {
  it("asks to run the command, shows the reason and the redacted clipped command, both scope labels", async () => {
    const view = commandView({
      command: {
        ...commandView().command,
        command: `rm -rf /data token=s3cr3t ${"y".repeat(400)}`,
      },
    });
    const redact = (s: string) => s.replaceAll("s3cr3t", "***");
    const zh = await approvalCard(cardDeps(view), "ca1", "https://cap.example", "zh", redact);
    expect(zh).toMatchObject({
      kind: "approval",
      title: "智能体想运行这条命令，允许吗？",
      toolName: "Bash",
      scopes: ["once", "session"],
      scopeLabels: { once: "允许一次", session: "本会话允许同类" },
      state: "pending",
      webUrl: "https://cap.example/chat/c1",
    });
    const lines = zh?.inputPreview.split("\n") ?? [];
    expect(lines[0]).toBe("Deletes files outside the workspace");
    expect(lines[1]).toBe("");
    const command = lines[2] as string;
    expect(command).toHaveLength(CARD_SUMMARY_MAX);
    expect(command.endsWith("…")).toBe(true);
    expect(command).toContain("token=***");
    expect(zh?.inputPreview).not.toContain("s3cr3t");
    const en = await approvalCard(cardDeps(view), "ca1", "https://cap.example", "en", redact);
    expect(en).toMatchObject({ title: "The agent wants to run this command. Allow?" });
    expect(en?.scopeLabels).toEqual({
      once: "Allow once",
      session: "Allow this kind for this conversation",
    });
  });

  it("a write names its path and never the tool key; a classifier ask labels once only", async () => {
    const write = commandView({
      toolKey: "Write",
      command: {
        ...commandView().command,
        kind: "write",
        command: "Write",
        path: "/etc/capybara/config.yaml",
      },
      scopes: ["once"],
    });
    const card = await approvalCard(cardDeps(write), "ca1", "https://cap.example", "zh");
    expect(card?.title).toBe("智能体想写入这个文件，允许吗？");
    expect(card?.inputPreview.split("\n").at(-1)).toBe("/etc/capybara/config.yaml");
    expect(card?.inputPreview).not.toContain("Write");
    expect(card?.scopeLabels).toEqual({ once: "允许一次" });
  });

  it("commandCardText alone says the same in both languages", () => {
    const detail = { kind: "command" as const, command: "ls -la", reason: "Reads the workspace" };
    expect(commandCardText(detail, ["once"], "zh").title).toBe("智能体想运行这条命令，允许吗？");
    expect(commandCardText(detail, ["once", "session"], "en")).toMatchObject({
      inputPreview: "Reads the workspace\n\nls -la",
      scopeLabels: {
        once: "Allow once",
        session: "Allow this kind for this conversation",
      },
    });
  });

  it("the text fallback carries the title, the reason, the command and the scope labels", async () => {
    const card = await approvalCard(cardDeps(commandView()), "ca1", "https://cap.example", "en");
    const text = renderCardAsText(card as NonNullable<typeof card>, "en");
    expect(text).toContain("The agent wants to run this command. Allow?");
    expect(text).toContain("Deletes files outside the workspace");
    expect(text).toContain("Allow once / Allow this kind for this conversation");
    const zh = await approvalCard(
      cardDeps(commandView({ scopes: ["once"] })),
      "ca1",
      "https://cap.example",
      "zh",
    );
    expect(renderCardAsText(zh as NonNullable<typeof zh>, "zh")).toContain("允许一次");
    expect(renderCardAsText(zh as NonNullable<typeof zh>, "zh")).not.toContain("本会话允许同类");
  });
});

// ── the clicker ────────────────────────────────────────────────────────────

type Chain = {
  select(): Chain;
  where(): Chain;
  executeTakeFirst(): Promise<unknown>;
};

/** The three reads `ChannelCardActions.handle` makes, by table. */
const fakeDb = (rows: {
  card?: unknown;
  thread?: unknown;
  approvalKind?: string;
}): KernelSchemaDb => {
  const query = (table: string): Chain => {
    const chain: Chain = {
      select: () => chain,
      where: () => chain,
      executeTakeFirst: async () => {
        if (table === "channel_card_messages") return rows.card;
        if (table === "channel_threads") return rows.thread;
        if (table === "approvals")
          return rows.approvalKind === undefined ? undefined : { kind: rows.approvalKind };
        return undefined;
      },
    };
    return chain;
  };
  return { selectFrom: query } as unknown as KernelSchemaDb;
};

const CARD = {
  conversation_id: "c1",
  target: { chatId: "chat", chatType: "group", threadId: "th" },
};

const click = (over: Record<string, unknown> = {}) =>
  ({
    type: "card_action",
    messageId: "m1",
    eventId: "e1",
    sender: { externalId: "u1", tenantId: "t1", locale: "zh" },
    target: { chatId: "chat", chatType: "group", threadId: "th" },
    action: { cardKind: "approval", cardId: "ca1", action: "approve", scope: "session" },
    ...over,
  }) as never;

const actions = (
  rows: { card?: unknown; thread?: unknown; approvalKind?: string },
  speaker: { accountId: string; threadAccount: string | null },
) => {
  const decide = vi.fn(async () => undefined);
  const send = vi.fn(async () => ({ messageId: "m2" }));
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    db: fakeDb(rows),
    connections: {
      row: async () => ({ id: "conn1", orgId: "o1", status: "active", pluginEnabled: true }),
      send,
    },
    approvals: { decide },
    questions: { answer: vi.fn() },
    outbound: { enqueue },
    resolveSpeaker: async () => speaker,
  } as unknown as ChannelCardActionsDeps;
  return { handler: new ChannelCardActions(deps), decide, send, enqueue };
};

describe("a command ask's click in IM", () => {
  it("the shared anonymous guest account never decides one", async () => {
    const a = actions(
      { card: CARD, thread: { conversation_id: "c1" }, approvalKind: "command" },
      { accountId: "guest", threadAccount: null },
    );
    await a.handler.handle("conn1", click());
    expect(a.decide).not.toHaveBeenCalled();
    expect(a.enqueue).not.toHaveBeenCalled();
    const reply = a.send.mock.calls[0] as unknown as [string, unknown, { text: string }];
    expect(reply[2].text).toBe("你不能处理这条请求。");
  });

  it("a bound clicker is re-authorized by the approval service with the clicked scope", async () => {
    const a = actions({ card: CARD }, { accountId: "a1", threadAccount: "a1" });
    await a.handler.handle("conn1", click());
    expect(a.decide).toHaveBeenCalledWith(
      "o1",
      "ca1",
      "a1",
      { decision: "approve", scope: "session" },
      undefined,
      "im",
    );
    expect(a.enqueue).toHaveBeenCalledWith("c1");
  });

  it("an anonymous click on a tool approval still decides, as once only", async () => {
    const a = actions(
      { card: CARD, thread: { conversation_id: "c1" }, approvalKind: "tool" },
      { accountId: "guest", threadAccount: null },
    );
    await a.handler.handle("conn1", click());
    expect(a.decide).toHaveBeenCalledWith(
      "o1",
      "ca1",
      "guest",
      { decision: "approve", scope: "once" },
      undefined,
      "im",
    );
  });
});
