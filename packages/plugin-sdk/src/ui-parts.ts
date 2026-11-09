/** The ARIA / data states a part promises (client extensions spec §7.1). */
export type UiPartState =
  | "aria-current"
  | "aria-selected"
  | "aria-expanded"
  | "aria-busy"
  | "disabled";

/** Every part name of the catalog, in catalog order. */
export const UI_PART_NAMES = [
  "shell",
  "sidebar",
  "sidebar.brand",
  "sidebar.item",
  "title-bar",
  "page-header",
  "thread",
  "message.user",
  "message.assistant",
  "tool-row",
  "composer",
  "properties-panel",
  "section",
  "right-panel",
  "status-bar",
  "button",
  "button.primary",
  "card",
  "input",
  "dialog",
] as const;

export type UiPartName = (typeof UI_PART_NAMES)[number];

/** One built-in element plugin CSS may select with `[data-cap-part~="<name>"]`. */
export interface UiPartSpec {
  name: UiPartName;
  /** Bumped when the part is renamed, removed or drops a promised state. */
  version: number;
  /**
   * The files (relative to the repository root) that render the element: one concept can be drawn
   * by several components (a sidebar row, a card). `check:ui-parts` pins each literal to one of them.
   */
  owner: readonly string[];
  states: readonly UiPartState[];
  description: { en: string; zh: string };
}

export const UI_PARTS: readonly UiPartSpec[] = [
  {
    name: "shell",
    version: 1,
    owner: ["packages/design/src/shell/app-shell.tsx"],
    states: [],
    description: {
      en: "The App Shell root.",
      zh: "应用外壳的根节点。",
    },
  },
  {
    name: "sidebar",
    version: 1,
    owner: ["packages/design/src/shell/sidebar.tsx"],
    states: [],
    description: {
      en: "The left sidebar.",
      zh: "左侧边栏。",
    },
  },
  {
    name: "sidebar.brand",
    version: 1,
    owner: ["packages/design/src/shell/sidebar.tsx"],
    states: [],
    description: {
      en: "The brand row of the sidebar.",
      zh: "侧边栏的品牌行。",
    },
  },
  {
    name: "sidebar.item",
    version: 1,
    owner: [
      "packages/design/src/shell/sidebar.tsx",
      "packages/design/src/shell/sidebar-conversations.tsx",
    ],
    states: ["aria-current"],
    description: {
      en: "A navigation or conversation row of the sidebar.",
      zh: "侧边栏的导航行或对话行。",
    },
  },
  {
    name: "title-bar",
    version: 1,
    owner: ["packages/design/src/conversation/title-bar.tsx"],
    states: [],
    description: {
      en: "The conversation title bar.",
      zh: "对话标题栏。",
    },
  },
  {
    name: "page-header",
    version: 1,
    owner: ["packages/design/src/shell/page-header.tsx"],
    states: [],
    description: {
      en: "The header of a page.",
      zh: "页面头部。",
    },
  },
  {
    name: "thread",
    version: 1,
    owner: ["packages/design/src/templates/conversation-page.tsx"],
    states: ["aria-busy"],
    description: {
      en: "The conversation stream.",
      zh: "对话消息流。",
    },
  },
  {
    name: "message.user",
    version: 1,
    owner: ["packages/design/src/conversation/bubble.tsx"],
    states: [],
    description: {
      en: "A person's message.",
      zh: "用户发出的消息。",
    },
  },
  {
    name: "message.assistant",
    version: 1,
    owner: ["apps/web/src/components/conversation/Thread.tsx"],
    states: [],
    description: {
      en: "An assistant turn.",
      zh: "智能体的一轮回复。",
    },
  },
  {
    name: "tool-row",
    version: 1,
    owner: ["packages/design/src/conversation/tool-row.tsx"],
    states: ["aria-expanded"],
    description: {
      en: "A tool call line.",
      zh: "工具调用行。",
    },
  },
  {
    name: "composer",
    version: 1,
    owner: ["packages/design/src/conversation/composer.tsx"],
    states: ["aria-busy"],
    description: {
      en: "The composer box.",
      zh: "输入框。",
    },
  },
  {
    name: "properties-panel",
    version: 1,
    owner: ["packages/design/src/conversation/panels.tsx"],
    states: [],
    description: {
      en: "The conversation properties panel.",
      zh: "对话属性面板。",
    },
  },
  {
    name: "section",
    version: 1,
    owner: [
      "packages/design/src/conversation/panels.tsx",
      "packages/design/src/templates/form-page.tsx",
    ],
    states: [],
    description: {
      en: "A property section or form section.",
      zh: "属性分区或表单分区。",
    },
  },
  {
    name: "right-panel",
    version: 1,
    owner: ["packages/design/src/conversation/panels.tsx"],
    states: [],
    description: {
      en: "A full-height right pane.",
      zh: "占满高度的右侧窗格。",
    },
  },
  {
    name: "status-bar",
    version: 1,
    owner: ["packages/design/src/shell/status-bar.tsx"],
    states: [],
    description: {
      en: "The status bar.",
      zh: "状态栏。",
    },
  },
  {
    name: "button",
    version: 1,
    owner: ["packages/design/src/controls/button.tsx"],
    states: ["disabled"],
    description: {
      en: "Every button.",
      zh: "所有按钮。",
    },
  },
  {
    name: "button.primary",
    version: 1,
    owner: ["packages/design/src/controls/button.tsx"],
    states: ["disabled"],
    description: {
      en: "A primary button (carried together with `button`).",
      zh: "主按钮（与 button 同时出现）。",
    },
  },
  {
    name: "card",
    version: 1,
    owner: [
      "packages/design/src/layout/index.tsx",
      "packages/design/src/conversation/panels.tsx",
      "packages/design/src/display/card-grid.tsx",
    ],
    states: [],
    description: {
      en: "A card, inline card or object card.",
      zh: "卡片、行内卡片或对象卡片。",
    },
  },
  {
    name: "input",
    version: 1,
    owner: ["packages/design/src/controls/inputs.tsx", "packages/design/src/controls/select.tsx"],
    states: ["disabled"],
    description: {
      en: "Text inputs, textareas and selects.",
      zh: "文本框、多行文本框和下拉选择。",
    },
  },
  {
    name: "dialog",
    version: 1,
    owner: ["packages/design/src/overlays/dialog.tsx", "packages/design/src/overlays/sheet.tsx"],
    states: [],
    description: {
      en: "A dialog or sheet.",
      zh: "对话框或抽屉。",
    },
  },
];

export function uiPart(name: string): UiPartSpec | undefined {
  return UI_PARTS.find((p) => p.name === name);
}
