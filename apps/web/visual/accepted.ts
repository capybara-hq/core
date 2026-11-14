/**
 * Components accepted against the reference set (spec §9.6): fidelity.spec.ts measures their
 * `/dev/ui/reference/<component>` blocks against the design spec's size tables and checks state
 * coverage. A component is appended once its side-by-side acceptance is done.
 */
export const ACCEPTED: string[] = [
  "button",
  "input",
  // the form Select (maintainer decision R, 2026-11-07): blocks and size table in place; the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "select",
  "segmented",
  "switch",
  "filter-chip",
  "table",
  "icon",
  "sidebar",
  "page-header",
  // the head rhythm across the templates (spec §4.2 "Head rhythm", acceptance item S): blocks and
  // size table in place, and head-rhythm.spec.ts compares the offsets across the blocks; no
  // reference PNG (the blocks are the templates themselves, the reference-update workflow draws
  // the templates' own pages)
  "head-rhythm",
  "stat-cards",
  "status-bar",
  "action-row",
  "template-list",
  "template-form",
  // loading states of the Detail, Overview and Inbox templates (spec §5.2, §5.6, §5.7): blocks and
  // size tables in place; the reference PNGs wait for the reference-update workflow
  "template-detail",
  "template-overview",
  "template-inbox",
  // the trace template's loading state (spec §5.11), accepted with the other template loading states
  "template-trace",
  "template-settings",
  "template-wizard",
  "template-auth",
  "prose",
  "thinking-row",
  "user-bubble",
  // background Bash plan Task 9 added states: run-divider `notice`, tool-group and tool-row
  // `linked`, task-output-panel `stopping`; their blocks and size-table rows are in place, the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "run-divider",
  "tool-group",
  "tool-row",
  "diff-block",
  "approval-block",
  // network facts (network ask spec §6.5): blocks and size table in place; the reference PNGs wait
  // for the reference-update workflow
  "network-facts",
  "question-block",
  "connect-block",
  "queued-message",
  "file-card",
  "file-outputs",
  "attachment-strip",
  "file-preview",
  "subagent-group",
  "title-bar",
  "composer",
  // picker-menu: the anchored long-list state `long` (2026-11-07, issues N/N'/N'') has its block and
  // size-table rows in place; its reference PNG and side-by-side review wait for the
  // reference-update and visual-update workflows
  "picker-menu",
  // phase D (Task 10): accepted by the blind side-by-side review (compare-out-d)
  "command-palette",
  "inline-card",
  "property-section",
  "right-panel",
  "template-conversation",
  // the role pass: blocks and size tables in place; the reference PNGs and the side-by-side review
  // wait for the reference-update and visual-update workflows
  "no-access",
  "danger-zone",
  "secret-reveal",
  // unslop fixes (2026-11-03): blocks and size table in place; the reference PNGs and the
  // side-by-side review wait for the reference-update and visual-update workflows
  "error-detail",
  "file-picker",
  // the run row (Task 9): blocks and size table in place; the reference PNGs and the side-by-side
  // review wait for the reference-update and visual-update workflows
  "run-row",
  // the working line (conversation send spec §2.2): blocks and size table in place; the reference
  // PNGs and the side-by-side review wait for the reference-update and visual-update workflows
  "working-line",
  // the new conversation page (agent profile design §4): blocks and size tables in place; the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "greeting",
  "agent-row",
  "quick-actions",
  // the agent map (agent map spec §9, plan Task B1): blocks and size table in place; the reference
  // PNGs and the side-by-side review wait for the reference-update and visual-update workflows
  "agent-map",
  // the agents chip (acceptance item AC3) and the user bubble's long / expanded states (AC4):
  // blocks and size tables in place; the reference PNGs and the side-by-side review wait for the
  // reference-update and visual-update workflows
  "agents-chip",
  // agent avatars (agent profile design §2.3): blocks and size table in place; the reference PNGs
  // and the side-by-side review wait for the reference-update and visual-update workflows
  "avatar",
  // config forms (Task 6): blocks and size tables in place; the reference PNGs and the
  // side-by-side review wait for the reference-update and visual-update workflows
  "repeater",
  "field-row",
  "key-value-editor",
  // skeleton primitives (spec §6.29): blocks and size table in place; the reference PNGs and the
  // side-by-side review wait for the reference-update and visual-update workflows
  "skeleton",
  // background task rows (background Bash plan Task 8): blocks and size table in place; the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "background-task",
  "task-output-panel",
  // plugin and component management acceptance (fix batch 1): blocks and size table in place;
  // the reference PNGs and the side-by-side review wait for the reference-update workflow
  "content-section",
  // one box is enough (acceptance item AB, wave 1): the groupings inside a box. Blocks, size
  // tables and the reference source are in place (also the new states repeater `divided`,
  // template-settings `items` / `loading-items`, template-conversation `properties-sheet`); the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "item-list",
  // the new state `divided` (the regions of an extension's Sheet, light polish 2026-11-07): the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  // what a change would do (text-pile pass 2026-11-07): blocks and size table in place; the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "impact-preview",
  "subsection",
  // the Callout adapts to the box it sits in (acceptance item AB, wave 2 fix round 1): states
  // `warn`, `info`, `in-box`; the reference PNGs and the side-by-side review wait for the
  // reference-update and visual-update workflows
  "callout",
  // cards on the page ground (plugin scope phase 4, ruling P4-15): CardGrid and ObjectCard, and
  // the List template's `cards` / `loading-cards`. Blocks, size tables and the reference source
  // are in place; the reference PNGs and the side-by-side review wait for the reference-update
  // and visual-update workflows
  "card-grid",
  // tools with their policy next to them (the agent page's 工具 section, 2026-11-08): blocks and
  // size table in place; the reference PNGs and the side-by-side review wait for the
  // reference-update and visual-update workflows
  "tool-policy-list",
  // CheckList (spec §6.39, maintainer acceptance 2026-11-12): blocks and size table in place; the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "check-list",
  // the theme picker's card (themes spec §10, plan Task 11): blocks and size table in place; the
  // reference PNGs and the side-by-side review wait for the reference-update and visual-update
  // workflows
  "theme-swatch",
  // the theme picker's radio group (Task 13 fix round): block and size table in place; the reference
  // PNGs and the side-by-side review wait for the reference-update and visual-update workflows
  "theme-swatch-group",
  // one section of an overview page in its own state (admin overview design §10.2): blocks and
  // size table in place; the reference PNGs and the side-by-side review wait for the
  // reference-update and visual-update workflows
  "overview-section",
  // the usage chart, two panels on one x-axis (admin overview design §10.1): blocks and size table
  // in place; the reference PNGs, the maintainer sign-off and the side-by-side review wait for
  // the reference-update and visual-update workflows
  "trend-chart",
  // the scheduled tasks calendar (scheduled tasks calendar design §6, §11): blocks and size table
  // in place; the reference PNGs and the side-by-side review wait for the reference-update and
  // visual-update workflows
  "schedule-calendar",
  // a device's head and its two modes (auto mode design §4, plan Task 10): blocks and size tables
  // in place; the reference PNGs and the side-by-side review wait for the reference-update and
  // visual-update workflows
  "device-nameplate",
  "mode-scale",
];

/**
 * Templates with a loading state: skeleton-alignment.spec.ts compares each loading block's part
 * boxes with the loaded block's. `loaded` / `loading` are the reference block ids (without the
 * `template-<name>-` prefix) that draw the same page loaded and loading; a template may have
 * several pairs (List's objects variant, Inbox's records variant).
 */
const KV =
  "the loaded span detail's properties; the loading trace draws the detail card's text lines (spec §5.11)";

export const LOADING_TEMPLATES: {
  name: string;
  pairs: { loaded: string; loading: string; dataOnly?: Record<string, string> }[];
}[] = [
  {
    name: "detail",
    pairs: [
      { loaded: "default", loading: "loading" },
      {
        loaded: "content",
        loading: "loading-content",
        dataOnly: {
          row: "the loaded replicas table's rows; the loading DataTable draws its own skeleton rows",
          cell: "the loaded replicas table's cells; the loading DataTable draws its own skeleton rows",
        },
      },
    ],
  },
  {
    name: "overview",
    pairs: [
      { loaded: "default", loading: "loading" },
      { loaded: "keep", loading: "loading-keep" },
    ],
  },
  {
    name: "inbox",
    pairs: [
      {
        loaded: "default",
        loading: "loading",
        dataOnly: {
          card: "the inbox content is one card-shaped block while loading (spec §5.7); the loaded page has its own sections",
        },
      },
      {
        loaded: "default-records",
        loading: "loading-records",
        dataOnly: {
          row: "the loaded table rows; the loading DataTable draws its own skeleton rows",
          cell: "the loaded table cells; the loading DataTable draws its own skeleton rows",
          card: "the inbox content is one card-shaped block while loading (spec §5.7); the loaded page has its own sections",
        },
      },
    ],
  },
  { name: "form", pairs: [{ loaded: "page", loading: "loading" }] },
  {
    name: "settings",
    pairs: [
      { loaded: "default", loading: "loading" },
      { loaded: "radio-cards", loading: "loading-radio-cards" },
      { loaded: "cards", loading: "loading-cards" },
      { loaded: "items", loading: "loading-items" },
    ],
  },
  {
    name: "wizard",
    pairs: [
      { loaded: "default", loading: "loading" },
      { loaded: "content", loading: "loading-content" },
    ],
  },
  { name: "auth", pairs: [{ loaded: "default", loading: "loading" }] },
  // the conversation's loading block is the file-panel block with every part still on its way
  {
    name: "conversation",
    pairs: [
      {
        loaded: "file-panel",
        loading: "loading",
        dataOnly: {
          button: "the loaded file panel's action; loading draws the panel's loading bars",
          prose: "the loaded assistant text; loading draws prose bars",
          markdown: "the loaded assistant text; loading draws prose bars",
          "tool-line": "the loaded tool rows; loading draws prose bars",
          "file-card": "the loaded file panel content; loading draws the panel's loading bars",
          "file-name": "the loaded file panel content; loading draws the panel's loading bars",
          "type-badge": "the loaded file panel content; loading draws the panel's loading bars",
          "panel-meta": "the loaded file panel content; loading draws the panel's loading bars",
          "preview-table": "the loaded file preview; loading draws the panel's loading bars",
          "preview-table-head": "the loaded file preview; loading draws the panel's loading bars",
          "preview-table-cell": "the loaded file preview; loading draws the panel's loading bars",
        },
      },
    ],
  },
  {
    name: "trace",
    pairs: [
      { loaded: "default", loading: "loading", dataOnly: { "key-value": KV, "key-value-row": KV } },
    ],
  },
  {
    name: "list",
    pairs: [
      { loaded: "default-objects", loading: "loading-objects" },
      { loaded: "keep", loading: "loading-keep" },
    ],
  },
];

/**
 * Parts whose loaded height follows the fixture's data, so a skeleton cannot match it by design:
 * the part is not compared in height, and the parts below it are compared in y after subtracting
 * the height difference of the exempt parts above them. Each entry carries its reason.
 */
export const VARIABLE_HEIGHT: Record<string, string> = {
  content:
    "the page's own sections or rows: the loading card blocks and the fixture sections differ",
  thread: "the loaded turns' text length decides the height; the skeleton draws three fixed turns",
  table: "the loaded table has the fixture's rows; the loading DataTable draws its own row count",
  card: "a loaded section card is as tall as its content; the loading card is the three-line shape",
  rail: "the inbox rail is as tall as its list: the fixture's items, or the loading list's own skeleton rows",
};

/**
 * Parts that are not laid out by the page: `link-pending` is the off-screen route announcer, and
 * `icon` / `icon-button` are numbered by position, so a loaded page with more icons than its
 * loading block cannot pair them (the title bar and header icons are compared through their own
 * parts).
 */
export const IGNORED_PARTS: string[] = ["link-pending", "icon", "icon-button"];

/**
 * Loading parts that stand in for a loaded part of another name: they pair with it by that name
 * (the box rows in the spec keep the `loading-` names).
 */
export const LOADING_ALIASES: Record<string, string> = {
  "loading-card": "card",
  "loading-inspector": "key-value",
  "loading-inspector-row": "key-value-row",
  "loading-switch-list": "switch-list",
  "loading-switch-row": "switch-row",
  "page-header-title-bar": "page-header-title",
  "page-header-action-slots": "page-header-actions",
  "loading-field": "field",
  "loading-bubble": "bubble",
  "loading-key-value": "key-value",
  "loading-shaped-card": "card",
  // item rows (spec §5.8 "Items", §6.33): the ItemList's own list and rows
  "loading-item-list": "item-list",
  "loading-item-group": "item-list",
  "loading-item-row": "item-list-row",
  // `<ancestor part> > <part>`: a placeholder box whose own part name is the generic skeleton-box
  "page-header-action-slots > skeleton-box": "button",
  "loading-switch-row > skeleton-box": "switch",
  "card > skeleton-box": "button",
  "loading-shaped-card > skeleton-box": "button",
  "loading-buttons > skeleton-box": "button",
  "loading-switch > skeleton-box": "switch",
};

/**
 * Parts of the loaded page that the loading block does not draw, by design: they exist only when
 * the data does (real text, rows, cells, actions). Every other loaded part, by name and count, must
 * be present while loading. Each entry carries its reason.
 */
export const DATA_ONLY_PARTS: Record<string, string> = {
  "field-label": "the label text of a loaded field; counted through `field`",
  input:
    "the loaded control kinds are page data; the loading field (loading-field) stands in for each field and its count is compared through `field`",
  "input-control":
    "the loaded control kinds are page data; the loading field (loading-field) stands in for each field and its count is compared through `field`",
  textarea:
    "the loaded control kinds are page data; the loading field (loading-field) stands in for each field and its count is compared through `field`",
  select:
    "the loaded control kinds are page data; the loading field (loading-field) stands in for each field and its count is compared through `field`",
  segmented:
    "the loaded control kinds are page data; the loading field (loading-field) stands in for each field and its count is compared through `field`",
  segment:
    "the loaded control kinds are page data; the loading field (loading-field) stands in for each field and its count is compared through `field`",
  "switch-knob": "the knob inside a loaded switch; the switch box itself is counted (`switch`)",
  "select-label":
    "an option label inside a loaded select (one per option, only the current one visible); the select itself is a loaded control kind, counted through `field`",
  "bubble-body":
    "the text box inside a loaded message bubble (it collapses a long user message); the loading bubble is one bar, compared as `bubble`",
  "field-error": "a validation message exists only for typed data",
  "item-list-title":
    "an item row's title text; the loading row's title line holds a bar (`item-list-head` is compared)",
  "item-list-code":
    "an item row's mono id is page data; the loading row's title line holds one bar for both",
  "action-row-unsaved":
    "an unsaved count the page cannot know yet; the loading action row has none (spec §5.3)",
  "action-row-errors":
    "an error count the page cannot know yet; the loading action row has none (spec §5.3)",
};

/**
 * Parts whose loaded width follows text or siblings the page does not know yet.
 */
export const VARIABLE_WIDTH: Record<string, string> = {
  "page-header-title":
    "the loaded title is its text; the loading title is a bar 30% of the row wide",
  "page-header-actions":
    "the loaded buttons are as wide as their labels; a placeholder is 72 px (right edge compared)",
  bubble:
    "the loaded user bubble is as wide as its text; the loading bubble is 45% of the thread (right edge compared)",
  title: "the loaded title is its text; the skeleton is a bar of the bar's width",
  "page-header-description":
    "ends where the loaded action buttons begin: a placeholder button is 72 px, a real one is as wide as its label",
};

/** Variable-width parts that sit at the right edge: their right edge is compared instead of x. */
export const RIGHT_ALIGNED: string[] = ["page-header-actions", "bubble"];

/**
 * Parts compared in y and height only: their width (and so the x of the ones after them) is the
 * label's text, which a placeholder cannot know (a header action slot is 72 px, a real button is
 * as wide as its label).
 */
export const HEIGHT_ONLY: Record<string, string> = {
  button: "a real button is as wide as its label; the header's action slots are 72 px",
};
