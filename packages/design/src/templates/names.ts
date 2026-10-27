/** The page template components of spec §5 (T1–T12; ConversationPage is T7, it replaced PlaygroundPage). */
export const PAGE_TEMPLATES = [
  "OverviewPage",
  "ListPage",
  "DetailPage",
  "FormPage",
  "SettingsPage",
  "InboxPage",
  "ConversationPage",
  "TracePage",
  "WizardPage",
  "AuthPage",
  "StatusPage",
  "OnboardingPage",
] as const;

export type PageTemplateName = (typeof PAGE_TEMPLATES)[number];
