/** A plugin's display name in both UI languages (plugin.json `displayName`). */
type LocalizedName = { zh: string; en: string };

import { apiFetch } from "./api";
import type { Approval } from "./approvals";
import type { AutomationPauseReason } from "./automations";
import type { CatalogRequest } from "./catalog";
import type { SkillChange } from "./skills";

/**
 * 收件箱（内核 `GET /orgs/:orgId/inbox`，按类型汇总）：当前用户能处理的待处理工具审批与
 * 作为 agent 负责人能决定的技能变更，以及（组织管理员）成员提交的目录申请；新的在前，最多 100 项，`truncated` 表示还有更多。
 */
export type InboxItem =
  | { type: "tool_approval"; id: string; createdAt: string; approval: Approval }
  | { type: "skill_change"; id: string; createdAt: string; skillChange: SkillChange }
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequest }
  /** My own request in this org, approved or rejected (with the reason); `createdAt`: decided. */
  | { type: "catalog_request_decided"; id: string; createdAt: string; request: CatalogRequest }
  /** My automation that needs me (`id`: `<taskId>:paused` or `<taskId>:grants`). */
  | { type: "automation_attention"; id: string; createdAt: string; attention: AutomationAttention }
  /** One of my own personal items, from the kernel or a plugin (collaboration spec §4.9). */
  | { type: "item"; id: string; createdAt: string; item: PersonalInboxItem }
  /** Work a source assigned to me and my agent, waiting for me to accept or decline it. */
  | { type: "automation_offer"; id: string; createdAt: string; offer: AutomationOffer }
  | { type: OrgNotice["kind"]; id: string; createdAt: string; notice: OrgNotice };

/**
 * A personal inbox item (kernel `PersonalInboxItemView`): only its person sees it. A button calls
 * the plugin's action as me when pressed (never named here); dismissing closes it without calling.
 */
export interface PersonalInboxItem {
  id: string;
  source: "kernel" | "plugin";
  /** The posting plugin; null for an item of the platform itself. */
  plugin: string | null;
  /** The plugin's display name; null for the platform's own items. */
  pluginName: LocalizedName | null;
  /** The platform's own kinds (`automation_depth_stopped`) read with their own copy. */
  kind: string;
  title: string;
  body: string;
  /** An in-app path (a plugin's item opens one of its pages). */
  link: string | null;
  actions: { id: string; label: LocalizedName; style?: "primary" | "danger" }[];
  /**
   * The platform's own facts of one of its items, read by its kind's copy (a declined offer:
   * `declinedBy`, `agent`, and `subjectUrl` when the item is outside the app); null for a plugin's.
   */
  detail: Record<string, unknown> | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * Work a source assigned to me and my agent, offered because my acceptance rule for it is
 * `confirm` (kernel `AutomationOfferView`, collaboration spec §4.4): accepting lets the agent work
 * on it as me; declining tells whoever assigned it. It expires after seven days.
 */
export interface AutomationOffer {
  id: string;
  source: string;
  sourceName: LocalizedName;
  agent: { id: string; name: string };
  eventType: string;
  subject: { kind: string; id: string; title: string; url?: string };
  /** What happened, as the source reports it. */
  summary: string;
  /** The offer's own item (its push opens `#item=<this id>`); null when none was posted. */
  inboxItemId: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * An automation of mine that needs me (kernel `AutomationAttentionView`, automations spec §8):
 * paused for any reason but my own pause, or its latest run was refused tools (`missing_grants`).
 */
export interface AutomationAttention {
  taskId: string;
  name: string;
  /** `failed`: its latest run failed (`error`); `missing_grants`: tools refused; else paused. */
  reason: AutomationPauseReason | "missing_grants" | "failed";
  /** Who paused it (an admin's pause names the admin); else null. */
  pausedBy: { id: string; name: string; avatarUrl: string | null } | null;
  /**
   * `missing_grants`: the refused tool keys, `connection:<slug>` (connect that connector), or
   * `network:<host>` (a domain the run was refused).
   */
  missing: string[];
  /** The part of `missing` I can't approve up front (the tool needs a role I lack). */
  needsRole: string[];
  /** The `network:<host>` keys of `missing` outside the org's allowlist: only an org admin can add them. */
  needsAdmin: string[];
  /** `failed`: the run's error; else null. */
  error: string | null;
}

/** Who owns an item (kernel `Owner`). */
export type NoticeOwner = { kind: "platform" } | { kind: "org"; orgId: string; name: string };

/**
 * A notice for the org's admins until one of them dismisses it: the phase 3 kinds with their
 * `detail`. A kind this app does not know arrives as `{ kind: string; detail }`
 * and is shown generically.
 */
export type OrgNotice = { id: string; createdAt: string } & (
  | {
      kind: "item_shared";
      detail: {
        name: string;
        displayName?: LocalizedName | null;
        org: { id: string; name: string } | "all_orgs";
      };
    }
  | {
      kind: "shared_item_updated";
      detail: {
        name: string;
        displayName?: LocalizedName | null;
        from: string;
        to: string;
        owner: NoticeOwner;
      };
    }
  | {
      kind: "upload_confirmed";
      detail: { name: string; displayName?: LocalizedName | null; version: string };
    }
  | {
      kind: "upload_rejected";
      detail: {
        name: string;
        displayName?: LocalizedName | null;
        version: string;
        reason: string | null;
      };
    }
);

/** An item carrying an org notice (every kind of {@link OrgNotice}, also one this app does not know). */
export const hasNotice = (i: InboxItem): i is Extract<InboxItem, { notice: OrgNotice }> =>
  "notice" in i && typeof i.notice === "object" && i.notice !== null;

/** Whether this app can show the item: a known type, or any notice (shown generically). */
export const isShowable = (i: InboxItem): boolean =>
  hasNotice(i) ||
  i.type === "tool_approval" ||
  i.type === "skill_change" ||
  i.type === "catalog_request" ||
  i.type === "catalog_request_decided" ||
  i.type === "automation_attention" ||
  i.type === "item" ||
  i.type === "automation_offer";

export interface InboxView {
  items: InboxItem[];
  truncated: boolean;
}

export const listInbox = (orgId: string) =>
  apiFetch<InboxView>(`/api/v1/orgs/${encodeURIComponent(orgId)}/inbox`);

/** I press a button of my own item: the plugin's action runs as me, then the item closes. */
export const clickInboxItemAction = (
  orgId: string,
  id: string,
  actionId: string,
  locale: "zh" | "en",
) =>
  apiFetch<{ toast?: LocalizedName }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/inbox/items/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
    { method: "POST", body: JSON.stringify({ locale }) },
  );

/** I dismiss my own item without pressing a button (204). */
export const dismissInboxItem = (orgId: string, id: string) =>
  apiFetch<void>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/inbox/items/${encodeURIComponent(id)}/dismiss`,
    { method: "POST" },
  );

/** An org admin dismisses a notice from the inbox (204). */
export const dismissNotice = (orgId: string, id: string) =>
  apiFetch<void>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/inbox/notices/${encodeURIComponent(id)}/dismiss`,
    { method: "POST" },
  );
