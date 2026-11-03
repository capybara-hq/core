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
