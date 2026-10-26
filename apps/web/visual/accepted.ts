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
];
