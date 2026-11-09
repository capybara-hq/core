import type { UiKind, UiPlace } from "./ui.js";

export type UiSlotScope = "conversation" | "agent" | "org" | "platform" | "file";
export type UiSlotRole = "guest" | "member" | "admin" | "superAdmin";

/** Every slot id of the catalog, in catalog order (UI slots spec §3). */
export const UI_SLOT_IDS = [
  "conversation.panel",
  "conversation.properties.section",
  "conversation.tool-result.card",
  "org.page",
  "file.preview",
  "agent.detail.section",
  "org.settings.section",
  "platform.page",
  "shell.brand",
  "shell.overlay",
  "conversation.empty",
  "conversation.composer.frame",
] as const;

export type UiSlotId = (typeof UI_SLOT_IDS)[number];

/** One slot of the catalog: where extension UI may go and what it receives (UI slots spec §3.1). */
export interface UiSlotSpec {
  id: UiSlotId;
  /** Bumped only on an incompatible change of the slot's contract. */
  version: number;
  /** Path relative to `apps/web/src` of the component that renders the slot. */
  owner: string;
  scope: UiSlotScope;
  accepts: readonly UiKind[];
  /** `single`: one winner replaces the built-in; `list`: every contribution is shown. */
  cardinality: "list" | "single";
  /** A single slot replaces a built-in block (client extensions spec §6.1). */
  replaceable?: true;
  /** What a replaceable slot shows without a winner. */
  builtin?: { en: string; zh: string };
  minRole: UiSlotRole;
  /** Context ids passed to render (`conversationId`, `agentId`, …). */
  args: readonly string[];
  density: "dense" | "regular";
  icon: "required" | "optional" | "none";
  /** Built-in parts a contribution may be placed after; the first is the default. */
  anchors?: readonly string[];
  limits?: { maxShown?: number };
  description: { en: string; zh: string };
}

const SLOT_DATA = [
  {
    id: "conversation.panel",
    version: 1,
    owner: "components/conversation/RightArea.tsx",
    scope: "conversation",
    accepts: ["view", "embed", "component"],
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
    accepts: ["view", "embed", "component"],
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
    accepts: ["view", "embed", "component"],
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
    accepts: ["view", "embed", "component"],
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
    accepts: ["view", "embed", "component"],
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
    accepts: ["view", "embed", "component"],
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
    accepts: ["view", "embed", "component"],
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
  {
    id: "shell.brand",
    version: 1,
    owner: "components/shell/AppFrame.tsx",
    scope: "org",
    accepts: ["component"],
    cardinality: "single",
    replaceable: true,
    builtin: { en: "The logo and wordmark in the sidebar.", zh: "侧边栏中的标志与字标。" },
    minRole: "guest",
    args: [],
    density: "regular",
    icon: "none",
    description: {
      en: "The brand row of the sidebar (the mark of the collapsed rail).",
      zh: "侧边栏的品牌行（收起后的窄栏标记）。",
    },
  },
  {
    id: "shell.overlay",
    version: 1,
    owner: "components/shell/AppFrame.tsx",
    scope: "org",
    accepts: ["component"],
    cardinality: "list",
    minRole: "guest",
    args: [],
    density: "regular",
    icon: "none",
    limits: { maxShown: 4 },
    description: {
      en: "A full-viewport layer over the workspace shell.",
      zh: "覆盖工作区外壳的全视口图层。",
    },
  },
  {
    id: "conversation.empty",
    version: 1,
    owner: "components/conversation/NewConversation.tsx",
    scope: "org",
    accepts: ["component"],
    cardinality: "single",
    replaceable: true,
    builtin: { en: "The greeting of the new-conversation page.", zh: "新对话页的问候区。" },
    minRole: "guest",
    args: [],
    density: "regular",
    icon: "none",
    description: {
      en: "The hero of the new-conversation page.",
      zh: "新对话页的主视觉区。",
    },
  },
  {
    id: "conversation.composer.frame",
    version: 1,
    owner: "components/conversation/ComposerBar.tsx",
    scope: "org",
    accepts: ["component"],
    cardinality: "single",
    replaceable: true,
    builtin: { en: "The frame around the message composer.", zh: "消息输入框外的边框。" },
    minRole: "guest",
    args: [],
    density: "regular",
    icon: "none",
    description: {
      en: "The frame around the composer, on the new-conversation and conversation pages.",
      zh: "新对话页与对话页中输入框外的边框。",
    },
  },
] as const satisfies readonly UiSlotSpec[];

export const UI_SLOTS: readonly UiSlotSpec[] = SLOT_DATA;

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

/** Slots with one winner that replaces a built-in block. */
export const UI_SINGLE_SLOTS: readonly UiSlotId[] = UI_SLOTS.filter(
  (s) => s.cardinality === "single",
).map((s) => s.id);

/** Slots that accept the `component` kind. */
export const UI_COMPONENT_SLOTS: readonly UiSlotId[] = UI_SLOTS.filter((s) =>
  s.accepts.includes("component"),
).map((s) => s.id);

export const UI_CONTRIBUTION_KEY_RE = /^[a-z][a-z0-9-]{1,40}\/[a-z][a-z0-9-]{0,39}$/;

export function uiContributionKey(plugin: string, id: string): string {
  return `${plugin}/${id}`;
}
