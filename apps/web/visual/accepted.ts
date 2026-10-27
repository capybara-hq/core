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
];

/**
 * The conversation-page components of UI refresh B (design spec §5.4, §6.16): they have state lists
 * and size tables in the spec but are not accepted yet. The completeness case allows exactly these
 * to be missing from `ACCEPTED`; a component moves from here to `ACCEPTED` when it passes
 * side-by-side acceptance, and the list is empty when B is done (plan Task 22).
 */
export const PENDING_B: string[] = [
  "template-conversation",
  "title-bar",
  "composer",
  "picker-menu",
  "subagent-group",
  "inline-card",
  "property-section",
  "right-panel",
];
