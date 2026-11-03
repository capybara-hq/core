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
export const LOADING_TEMPLATES: { name: string; pairs: { loaded: string; loading: string }[] }[] = [
  { name: "detail", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "overview", pairs: [{ loaded: "default", loading: "loading" }] },
  {
    name: "inbox",
    pairs: [
      { loaded: "default", loading: "loading" },
      { loaded: "default-records", loading: "loading-records" },
    ],
  },
  { name: "form", pairs: [{ loaded: "page", loading: "loading" }] },
  { name: "settings", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "wizard", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "auth", pairs: [{ loaded: "default", loading: "loading" }] },
  // the conversation's loading block is the file-panel block with every part still on its way
  { name: "conversation", pairs: [{ loaded: "file-panel", loading: "loading" }] },
  { name: "trace", pairs: [{ loaded: "default", loading: "loading" }] },
  { name: "list", pairs: [{ loaded: "default-objects", loading: "loading-objects" }] },
];

/**
 * Parts whose loaded size follows the page's content (a prose body, a table's row count, a form
 * section's fields and help text, a title's text), so the skeleton cannot match it by design: they
 * are compared in x, y and width only, and a later part of the same name (the second form section)
 * is not compared in y either, because it sits below the earlier ones.
 */
export const VARIABLE_HEIGHT: string[] = [
  "content",
  "thread",
  "table",
  "title",
  "form-section",
  "form-section-head",
  "form-card",
];

/**
 * Parts that are not laid out by the page: `link-pending` is the off-screen route announcer, and
 * `icon` / `icon-button` are numbered by position, so a loaded page with more icons than its
 * loading block cannot pair them (the title bar and header icons are compared through their own
 * parts).
 */
export const IGNORED_PARTS: string[] = ["link-pending", "icon", "icon-button"];
