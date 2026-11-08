import type { UiKind, UiPlace } from "./ui.js";

export type UiSlotScope = "conversation" | "agent" | "org" | "platform" | "file";
export type UiSlotRole = "guest" | "member" | "admin" | "superAdmin";

interface SlotShape<Id extends string> {
  id: Id;
  version: number;
  /** Path relative to `apps/web/src` of the component that renders the slot. */
  owner: string;
  scope: UiSlotScope;
  accepts: readonly UiKind[];
  cardinality: "list";
  minRole: UiSlotRole;
  args: readonly string[];
  density: "dense" | "regular";
  icon: "required" | "optional" | "none";
  anchors?: readonly string[];
  limits?: { maxShown?: number };
  description: { en: string; zh: string };
}

export interface UiSlotSpec extends SlotShape<UiSlotId> {}

const SLOT_DATA = [
  {
    id: "conversation.panel",
    version: 1,
    owner: "components/conversation/RightArea.tsx",
    scope: "conversation",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "guest",
    args: ["conversationId", "item"],
    density: "regular",
    icon: "optional",
    description: {
      en: "A panel beside the conversation, opened from the right area.",
      zh: "对话旁的面板，从右侧区域打开。",
    },
  },
  {
    id: "conversation.properties.section",
    version: 1,
    owner: "components/conversation/PropertiesSections.tsx",
    scope: "conversation",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "guest",
    args: ["conversationId"],
    density: "dense",
    icon: "optional",
    anchors: ["context", "files", "background"],
    description: {
      en: "A section in the conversation properties list.",
      zh: "对话属性列表中的一个分区。",
    },
  },
  {
    id: "conversation.tool-result.card",
    version: 1,
    owner: "components/conversation/RightArea.tsx",
    scope: "conversation",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "guest",
    args: ["conversationId", "card"],
    density: "regular",
    icon: "optional",
    description: {
      en: "A card a tool result opens in the conversation.",
      zh: "工具结果在对话中打开的卡片。",
    },
  },
  {
    id: "org.page",
    version: 1,
    owner: "app/(app)/p/[plugin]/[id]/view.tsx",
    scope: "org",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "member",
    args: [],
    density: "regular",
    icon: "optional",
    description: {
      en: "A full page in the organization navigation.",
      zh: "组织导航中的完整页面。",
    },
  },
  {
    id: "file.preview",
    version: 1,
    owner: "components/conversation/FilePanel.tsx",
    scope: "file",
    accepts: ["embed"],
    cardinality: "list",
    minRole: "guest",
    args: ["conversationId", "fileId"],
    density: "regular",
    icon: "optional",
    description: {
      en: "A previewer for a file of the conversation.",
      zh: "对话中文件的预览器。",
    },
  },
  {
    id: "agent.detail.section",
    version: 1,
    owner: "components/agent/AgentPage.tsx",
    scope: "agent",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "guest",
    args: ["agentId"],
    density: "regular",
    icon: "optional",
    description: {
      en: "A section on the detail page of an agent.",
      zh: "智能体详情页中的一个分区。",
    },
  },
  {
    id: "org.settings.section",
    version: 1,
    owner: "app/(app)/settings/organization/view.tsx",
    scope: "org",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "admin",
    args: [],
    density: "regular",
    icon: "optional",
    description: {
      en: "A section on the organization settings page.",
      zh: "组织设置页中的一个分区。",
    },
  },
  {
    id: "platform.page",
    version: 1,
    owner: "app/(app)/admin/p/[plugin]/[id]/view.tsx",
    scope: "platform",
    accepts: ["view", "embed"],
    cardinality: "list",
    minRole: "superAdmin",
    args: [],
    density: "regular",
    icon: "optional",
    description: {
      en: "A full page in the platform administration.",
      zh: "平台管理中的完整页面。",
    },
  },
] as const satisfies readonly SlotShape<string>[];

export type UiSlotId = (typeof SLOT_DATA)[number]["id"];

export const UI_SLOTS: readonly UiSlotSpec[] = SLOT_DATA;

export const UI_SLOT_IDS = SLOT_DATA.map((s) => s.id) as unknown as readonly [
  UiSlotId,
  ...UiSlotId[],
];

export function uiSlot(id: string): UiSlotSpec | undefined {
  return UI_SLOTS.find((s) => s.id === id);
}

const SLOT_REF_RE = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)(?:@([1-9][0-9]{0,2}))?$/;

/** Reads `<id>` or `<id>@<version>` (version 1 when omitted); does not check the catalog. */
export function parseSlotRef(ref: string): { id: string; version: number } | null {
  const m = SLOT_REF_RE.exec(ref);
  if (!m) return null;
  return { id: m[1] as string, version: m[2] === undefined ? 1 : Number(m[2]) };
}

/** @deprecated step A of the UI slots spec §4 */
export const PLACE_SLOTS: Readonly<Record<UiPlace, UiSlotId>> = {
  panel: "conversation.panel",
  conversation: "conversation.panel",
  section: "conversation.properties.section",
  inline: "conversation.tool-result.card",
  page: "org.page",
  "file-preview": "file.preview",
};

export const UI_ARRANGEABLE_SLOTS: readonly UiSlotId[] = UI_SLOT_IDS.filter(
  (id) => id !== "file.preview",
);

export const UI_CONTRIBUTION_KEY_RE = /^[a-z][a-z0-9-]{1,40}\/[a-z][a-z0-9-]{0,39}$/;

export function uiContributionKey(plugin: string, id: string): string {
  return `${plugin}/${id}`;
}
