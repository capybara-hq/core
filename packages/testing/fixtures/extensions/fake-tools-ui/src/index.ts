import {
  defineExtension,
  type ExtensionContext,
  ToolError,
  type ToolSpec,
  type UiView,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of a tool + UI extension: the kernel contracts an extension tool, a schema-rendered
 * view, a migration and a full plugin bundle exercise, without the official todo plugin. Like todo
 * it needs no object store (storage is `fake-storage-user`'s).
 * - tool `write` (model-visible `fake-tools-ui__write`, default policy allow): replaces the
 *   conversation's item list in the extension's own table, then invalidates the view `tasks`;
 * - view `tasks` (conversation tab): badge `<done>/<total>` and a checklist;
 * - the plugin also ships the skill `fake-notes` and the connector template `fake-notes`
 *   (for the `fake-connector` extension).
 */

type Db = ExtensionContext["db"];

const Item = z.object({
  text: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});
const WriteInput = z.object({ items: z.array(Item).max(100) });

/** One item of the list. */
export type FakeItem = z.infer<typeof Item>;

const WRITE: ToolSpec = {
  name: "write",
  description:
    "Replace the item list of the current conversation. Send every item each time; status is " +
    "pending, in_progress or completed. Test fixture only.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        maxItems: 100,
        description: "The complete list, in order.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, description: "What the item is." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Progress of the item.",
            },
          },
          required: ["text", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  defaultPolicy: "allow",
};

const render = (items: FakeItem[]): string =>
  items.length === 0
    ? "The list is now empty."
    : `List updated (${items.length} items):\n${items.map((i) => `[${i.status}] ${i.text}`).join("\n")}`;

async function writeItems(db: Db, conversationId: string, items: FakeItem[]): Promise<void> {
  await db
    .insertInto("items")
    .values({ conversation_id: conversationId, items: JSON.stringify(items) })
    .onConflict((oc) =>
      oc.column("conversation_id").doUpdateSet((eb) => ({
        items: eb.ref("excluded.items"),
        updated_at: new Date(),
      })),
    )
    .execute();
}

async function readItems(db: Db, conversationId: string): Promise<FakeItem[]> {
  const row = await db
    .selectFrom("items")
    .select("items")
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst();
  return row === undefined ? [] : (row.items as FakeItem[]);
}

/** The `tasks` view of a list. */
export function tasksView(items: FakeItem[]): UiView {
  const done = items.filter((i) => i.status === "completed").length;
  return {
    badge: `${done}/${items.length}`,
    blocks: [{ type: "checklist", items: items.map((i) => ({ text: i.text, status: i.status })) }],
  };
}

export default defineExtension({
  name: "fake-tools-ui",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  migrations: "../migrations",
  ui: [{ id: "tasks", title: { zh: "条目", en: "Items" }, place: "conversation", kind: "view" }],
  permissions: { tools: ["write"], ui: { views: ["tasks"] } },
  setup(ctx) {
    ctx.tools.register(WRITE, async (input, tctx) => {
      const parsed = WriteInput.safeParse(input);
      if (!parsed.success) {
        throw new ToolError(
          "Invalid items: pass an array of { text, status } where status is pending, in_progress or completed.",
        );
      }
      const items = parsed.data.items;
      await writeItems(ctx.db, tctx.conversationId, items);
      await ctx.ui
        .invalidate({
          orgId: tctx.orgId,
          conversationId: tctx.conversationId,
          contribution: "tasks",
        })
        .catch(() => {});
      return {
        content: [{ type: "text", text: render(items) }],
        display: {
          summary: {
            zh: `更新条目（${items.length} 项）`,
            en: `Updated items (${items.length})`,
          },
        },
      };
    });
    ctx.ui.view("tasks", async ({ conversationId }) =>
      tasksView(conversationId === undefined ? [] : await readItems(ctx.db, conversationId)),
    );
  },
});
