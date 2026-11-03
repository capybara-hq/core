/**
 * Components accepted against the reference set (spec §9.6): fidelity.spec.ts measures their
 * `/dev/ui/reference/<component>` blocks against the design spec's size tables and checks state
 * coverage. A component is appended once its side-by-side acceptance is done.
 */
export const ACCEPTED: string[] = [
  "button",
  "input",
  "segmented",
  "switch",
  "filter-chip",
  "table",
  "icon",
  "sidebar",
  "page-header",
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
  "run-divider",
  "tool-group",
  "tool-row",
  "diff-block",
  "approval-block",
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
  // config forms (Task 6): blocks and size tables in place; the reference PNGs and the
  // side-by-side review wait for the reference-update and visual-update workflows
  "repeater",
  "field-row",
  "key-value-editor",
  // skeleton primitives (spec §6.29): blocks and size table in place; the reference PNGs and the
  // side-by-side review wait for the reference-update and visual-update workflows
  "skeleton",
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
  { name: "detail", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "overview", pairs: [{ loaded: "default", loading: "loading" }] },
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
          card: "the inbox content is one card-shaped block while loading (spec §5.7); the loaded page has its own sections",
        },
      },
    ],
  },
  { name: "form", pairs: [{ loaded: "page", loading: "loading" }] },
  { name: "settings", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "wizard", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "auth", pairs: [{ loaded: "default", loading: "loading" }] },
  // the conversation's loading block is the file-panel block with every part still on its way
  { name: "conversation", pairs: [{ loaded: "file-panel", loading: "loading" }] },
  {
    name: "trace",
    pairs: [
      { loaded: "default", loading: "loading", dataOnly: { "key-value": KV, "key-value-row": KV } },
    ],
  },
  { name: "list", pairs: [{ loaded: "default-objects", loading: "loading-objects" }] },
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
  "form-section":
    "the loaded fields carry help text and paired controls the placeholders cannot know",
  "form-section-head": "stretches to the form-section's row, so it has the section's height",
  card: "a loaded section card is as tall as its content; the loading card is the three-line shape",
  "form-card": "the loaded fields carry help text and paired controls the placeholders cannot know",
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
};

/**
 * Parts of the loaded page that the loading block does not draw, by design: they exist only when
 * the data does (real text, rows, cells, actions). Every other loaded part, by name and count, must
 * be present while loading. Each entry carries its reason.
 */
export const DATA_ONLY_PARTS: Record<string, string> = {
  button:
    "real buttons (header actions, a submit, a panel action); loading draws placeholder slots",
  "field-label": "the loaded form fields; loading draws field placeholders (loading-field)",
  input: "the loaded form fields; loading draws field placeholders (loading-field)",
  "input-control": "the loaded form fields; loading draws field placeholders (loading-field)",
  textarea: "the loaded form fields; loading draws field placeholders (loading-field)",
  select: "the loaded form fields; loading draws field placeholders (loading-field)",
  segmented: "the loaded form fields; loading draws field placeholders (loading-field)",
  segment: "the loaded form fields; loading draws field placeholders (loading-field)",
  switch: "the loaded switches; loading draws a 32 x 20 box in the switch row (loading-switch-row)",
  "switch-knob": "the loaded switches; loading draws a 32 x 20 box in the switch row",
  "field-error": "a validation message exists only for typed data",
  "action-row-unsaved":
    "an unsaved count the page cannot know yet; the loading action row has none (spec §5.3)",
  "action-row-errors":
    "an error count the page cannot know yet; the loading action row has none (spec §5.3)",
  row: "the loaded table rows; the loading DataTable draws its own skeleton rows",
  cell: "the loaded table cells; the loading DataTable draws its own skeleton rows",
  bubble: "the loaded user turn; loading draws loading-turn boxes (spec §5.4)",
  prose: "the loaded assistant text; loading draws prose bars",
  markdown: "the loaded assistant text; loading draws prose bars",
  "tool-line": "the loaded tool rows; loading draws prose bars",
  "file-card": "the loaded file panel content; loading draws the right panel's loading bars",
  "file-name": "the loaded file panel content; loading draws the right panel's loading bars",
  "type-badge": "the loaded file panel content; loading draws the right panel's loading bars",
  "panel-meta": "the loaded file panel content; loading draws the right panel's loading bars",
  "preview-table": "the loaded file preview; loading draws the right panel's loading bars",
  "preview-table-head": "the loaded file preview; loading draws the right panel's loading bars",
  "preview-table-cell": "the loaded file preview; loading draws the right panel's loading bars",
};

/**
 * Parts whose loaded width follows text or siblings the page does not know yet.
 */
export const VARIABLE_WIDTH: Record<string, string> = {
  "page-header-title":
    "the loaded title is its text; the loading title is a bar 30% of the row wide",
  title: "the loaded title is its text; the skeleton is a bar of the bar's width",
  "page-header-description":
    "ends where the loaded action buttons begin: a placeholder button is 72 px, a real one is as wide as its label",
};
