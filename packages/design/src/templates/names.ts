/** spec §5 的 12 个页面模板组件名（T1–T12）。 */
export const PAGE_TEMPLATES = [
  "OverviewPage",
  "ListPage",
  "DetailPage",
  "FormPage",
  "SettingsPage",
  "InboxPage",
  "PlaygroundPage",
  "TracePage",
  "WizardPage",
  "AuthPage",
  "StatusPage",
  "OnboardingPage",
] as const;

export type PageTemplateName = (typeof PAGE_TEMPLATES)[number];
