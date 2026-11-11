/** A plugin's display name in both UI languages (plugin.json `displayName`). */
type LocalizedName = { zh: string; en: string };

import { apiFetch } from "./api";
import type { Approval } from "./approvals";
import type { CatalogRequest } from "./catalog";
import type { SchedulePauseReason } from "./schedules";
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
  /** My scheduled task that needs me (`id`: `<taskId>:paused` or `<taskId>:grants`). */
  | { type: "schedule_attention"; id: string; createdAt: string; attention: ScheduleAttention }
  | { type: OrgNotice["kind"]; id: string; createdAt: string; notice: OrgNotice };

/**
 * A scheduled task of mine that needs me (kernel `ScheduleAttentionView`, scheduled tasks spec §8):
 * paused for any reason but my own pause, or its latest run was refused tools (`missing_grants`).
 */
export interface ScheduleAttention {
  taskId: string;
  name: string;
  /** `failed`: its latest run failed (`error`); `missing_grants`: tools refused; else paused. */
  reason: SchedulePauseReason | "missing_grants" | "failed";
  /** Who paused it (an admin's pause names the admin); else null. */
  pausedBy: { id: string; name: string } | null;
  /** `missing_grants`: the refused tool keys, or `connection:<slug>` (connect that connector). */
  missing: string[];
  /** The part of `missing` I can't approve up front (the tool needs a role I lack). */
  needsRole: string[];
  /** `failed`: the run's error; else null. */
  error: string | null;
}

/** Who owns an item (kernel `Owner`). */
export type NoticeOwner = { kind: "platform" } | { kind: "org"; orgId: string; name: string };

/**
 * A notice for the org's admins until one of them dismisses it: `skill_renamed` (an org skill the
 * platform components migration renamed; agents keep it, they select skills by id) and the phase 3
 * kinds with their `detail`. A kind this app does not know arrives as `{ kind: string; detail }`
 * and is shown generically.
 */
export type OrgNotice = { id: string; createdAt: string } & (
  | {
      kind: "skill_renamed";
      skillRenamed: {
        skillId: string;
        from: string;
        to: string;
        platformSkillId: string;
        plugin: string | null;
      };
    }
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
  i.type === "schedule_attention";

export interface InboxView {
  items: InboxItem[];
  truncated: boolean;
}

export const listInbox = (orgId: string) =>
  apiFetch<InboxView>(`/api/v1/orgs/${encodeURIComponent(orgId)}/inbox`);

/** An org admin dismisses a notice from the inbox (204). */
export const dismissNotice = (orgId: string, id: string) =>
  apiFetch<void>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/inbox/notices/${encodeURIComponent(id)}/dismiss`,
    { method: "POST" },
  );
