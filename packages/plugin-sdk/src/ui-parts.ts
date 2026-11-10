/** The ARIA / data states a part promises (client extensions spec §7.1). */
export type UiPartState =
  | "aria-current"
  | "aria-selected"
  | "aria-expanded"
  | "aria-busy"
  | "aria-checked"
  | "aria-pressed"
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
  "message.user.bubble",
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
  "code-block",
  "menu",
  "segmented",
  "stat-card",
  "switch",
  "switch.knob",
  "org-avatar",
  "agent-chip",
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
    name: "message.user.bubble",
    version: 1,
    owner: ["packages/design/src/conversation/bubble.tsx"],
    states: [],
    description: {
      en: "The bubble of a person's message (inside the full-width `message.user` row).",
      zh: "用户消息的气泡本身（在占满宽度的 message.user 行之内）。",
    },
  },
  {
    name: "message.assistant",
    version: 1,
    owner: ["apps/web/src/components/conversation/Thread.tsx"],
    states: ["aria-busy"],
    description: {
      en: "An assistant turn; `aria-busy` while its text is still streaming (the live reply).",
      zh: "智能体的一轮回复；正在流式输出时带 aria-busy（正在生成的回复）。",
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
  {
    name: "code-block",
    version: 1,
    owner: ["packages/design/src/display/chat.tsx"],
    states: [],
    description: {
      en: "A code block (Markdown code, setup guides, diffs).",
      zh: "代码块（Markdown 代码、设置指引、差异）。",
    },
  },
  {
    name: "menu",
    version: 1,
    owner: ["packages/design/src/overlays/menus.tsx", "packages/design/src/conversation/menu.tsx"],
    states: [],
    description: {
      en: "A menu, submenu, popover or the composer's menus.",
      zh: "菜单、子菜单、弹出层或输入框的菜单。",
    },
  },
  {
    name: "segmented",
    version: 1,
    owner: ["packages/design/src/display/tabs.tsx"],
    states: [],
    description: {
      en: "A segmented control (its segments are radios with `aria-checked`).",
      zh: "分段控件（各段是带 aria-checked 的单选项）。",
    },
  },
  {
    name: "stat-card",
    version: 1,
    owner: ["packages/design/src/display/stat-cards.tsx"],
    states: [],
    description: {
      en: "A metric card of a StatCards row.",
      zh: "指标卡片行里的一张指标卡。",
    },
  },
  {
    name: "switch",
    version: 1,
    owner: ["packages/design/src/controls/toggles.tsx"],
    states: ["aria-checked", "disabled"],
    description: {
      en: "A switch; `aria-checked` says on or off.",
      zh: "开关；aria-checked 表示开或关。",
    },
  },
  {
    name: "switch.knob",
    version: 1,
    owner: ["packages/design/src/controls/toggles.tsx"],
    states: [],
    description: {
      en: "The knob inside a `switch` (style it from the switch's state).",
      zh: "开关里的滑块（按所在开关的状态设置样式）。",
    },
  },
  {
    name: "org-avatar",
    version: 1,
    owner: ["packages/design/src/shell/sidebar.tsx"],
    states: [],
    description: {
      en: "The org's initial block in the sidebar's org switcher.",
      zh: "侧边栏组织切换器里的组织首字方块。",
    },
  },
  {
    name: "agent-chip",
    version: 1,
    owner: ["packages/design/src/conversation/agent-row.tsx"],
    states: ["aria-pressed"],
    description: {
      en: "An agent chip of the new conversation's agents row; `aria-pressed` on the selected one.",
      zh: "新会话智能体行里的智能体标签；选中的那个带 aria-pressed。",
    },
  },
];

export function uiPart(name: string): UiPartSpec | undefined {
  return UI_PARTS.find((p) => p.name === name);
}
