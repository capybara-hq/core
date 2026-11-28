import {
  defineExtension,
  type InboxCtx,
  type RunLifecyclePayload,
  type ToolCallContext,
  type ToolSpec,
  TriggerError,
  type TriggerEvent,
  type TriggerEventDeclaration,
  type TriggerSource,
} from "@capybara-hq/plugin-sdk";

/**
 * Test fake of a `trigger-source@1` provider (collaboration spec §4.2, §4.3). It declares the
 * event types `item.created`, `item.updated` and `item.assigned` (directed) in
 * `permissions.triggers.emit`, each with the filterable facts `status` (string), `priority`
 * (number), `labels` (string[]) and `projectKey` (string), and the unfilterable fact `internalNote`.
 * - The tool `emit_item_event` emits its input as the event through `ctx.triggers.emit`, with the
 *   call's org (unless the input names another `orgId`) and `cause: { call }`; it returns
 *   `{ eventId, duplicate }` as JSON, or `{ error: <TriggerError code> }` for a refused emit.
 * - `visible()` admits the accounts listed in `globalThis.__fakeTriggerSource.visible`, or every
 *   account when that is unset.
 * - Its setup puts `emit` (the extension's own `ctx.triggers.emit`) on the probe
 *   ({@link fakeTriggerSourceProbe}; in-process kernels only), so a test can emit as the extension
 *   outside a tool call; likewise `causeOf` (its `ctx.triggers.causeOf`) and `inbox` (its
 *   `ctx.inbox`, `permissions.inbox`).
 * - It observes `run.lifecycle` (`permissions.hooks`) and records every payload on the probe's
 *   `lifecycle`.
 * - The `org.page` view `requests` has a UI action that records every call on the probe's
 *   `actions` (`{ actionId, accountId, role, payload }`) and answers a toast; an action id `fail`
 *   throws instead (nothing recorded).
 */

// capybara:allow-module-state a read-only constant list
export const FAKE_TRIGGER_TYPES = ["item.created", "item.updated", "item.assigned"] as const;

/** The probe tests read and script. */
export interface FakeTriggerSourceProbe {
  /** The accounts `visible()` admits; undefined admits every account. */
  visible?: string[];
  /** The extension's `ctx.triggers.emit`, set by its setup. */
  emit?: (event: TriggerEvent) => Promise<{ eventId: string; duplicate: boolean }>;
  /** The extension's `ctx.triggers.causeOf`, set by its setup. */
  causeOf?: (call: ToolCallContext) => Promise<string>;
  /** The extension's `ctx.inbox`, set by its setup. */
  inbox?: InboxCtx;
  /** Every `run.lifecycle` payload the extension received (it subscribes), in order. */
  lifecycle?: RunLifecyclePayload[];
  /** The calls of the `requests` view's UI action, in order. */
  actions?: { actionId: string; accountId: string; role: string; payload: unknown }[];
}

export function fakeTriggerSourceProbe(): FakeTriggerSourceProbe {
  const g = globalThis as { __fakeTriggerSource?: FakeTriggerSourceProbe };
  g.__fakeTriggerSource ??= {};
  return g.__fakeTriggerSource;
}

const FACTS: TriggerEventDeclaration["facts"] = {
  status: { type: "string", name: { zh: "状态", en: "Status" }, filterable: true },
  priority: { type: "number", name: { zh: "优先级", en: "Priority" }, filterable: true },
  labels: { type: "string[]", name: { zh: "标签", en: "Labels" }, filterable: true },
  projectKey: { type: "string", name: { zh: "项目", en: "Project" }, filterable: true },
  // declared but not filterable: an automation's filter may not name it
  internalNote: {
    type: "string",
    name: { zh: "内部备注", en: "Internal note" },
    filterable: false,
  },
};

// capybara:allow-module-state a read-only constant list
const EVENTS: TriggerEventDeclaration[] = [
  {
    type: "item.created",
    name: { zh: "条目已创建", en: "Item created" },
    directed: false,
    facts: FACTS,
  },
  {
    type: "item.updated",
    name: { zh: "条目已更新", en: "Item updated" },
    directed: false,
    facts: FACTS,
  },
  {
    type: "item.assigned",
    name: { zh: "条目已指派", en: "Item assigned" },
    directed: true,
    facts: FACTS,
  },
];

const source: TriggerSource = {
  events: () => EVENTS,
  async visible({ accountIds }) {
    const allowed = fakeTriggerSourceProbe().visible;
    return allowed === undefined ? accountIds : accountIds.filter((a) => allowed.includes(a));
  },
};

const EMIT: ToolSpec = {
  name: "emit_item_event",
  description:
    "Emit an item event (type, subject, facts, summary, dedupeKey, optional audience) caused by this call. Test fixture only.",
  inputSchema: { type: "object", additionalProperties: true },
  defaultPolicy: "allow",
};

export default defineExtension({
  name: "fake-trigger-source",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["trigger-source@1"],
  ui: [{ id: "requests", title: { zh: "请求", en: "Requests" }, slot: "org.page", kind: "view" }],
  permissions: {
    tools: ["emit_item_event"],
    hooks: ["run.lifecycle"],
    triggers: { emit: [...FAKE_TRIGGER_TYPES] },
    inbox: true,
    ui: { views: ["requests"] },
  },
  setup(ctx) {
    ctx.provide("trigger-source@1", source);
    const probe = fakeTriggerSourceProbe();
    probe.emit = (event) => ctx.triggers.emit(event);
    probe.causeOf = (call) => ctx.triggers.causeOf(call);
    probe.inbox = ctx.inbox;
    ctx.hooks.on(
      "run.lifecycle",
      (p) => {
        const pr = fakeTriggerSourceProbe();
        pr.lifecycle ??= [];
        pr.lifecycle.push({ ...p });
      },
      { mode: "observe" },
    );
    ctx.ui.view("requests", async () => ({
      blocks: [{ type: "actions", buttons: [{ actionId: "accept", label: "Accept" }] }],
    }));
    ctx.ui.action("requests", async (args) => {
      if (args.actionId === "fail") throw new Error("the fake action failed");
      const accountId = "accountId" in args ? args.accountId : "";
      const role = "role" in args ? String(args.role) : "";
      fakeTriggerSourceProbe().actions ??= [];
      fakeTriggerSourceProbe().actions?.push({
        actionId: args.actionId,
        accountId,
        role,
        payload: args.payload,
      });
      return { toast: { zh: "已接受", en: "Accepted" } };
    });
    ctx.tools.register(EMIT, async (input, call) => {
      const event = { orgId: call.orgId, ...(input as object), cause: { call } } as TriggerEvent;
      try {
        const r = await ctx.triggers.emit(event);
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      } catch (err) {
        if (err instanceof TriggerError)
          return { content: [{ type: "text", text: JSON.stringify({ error: err.code }) }] };
        throw err;
      }
    });
  },
});
