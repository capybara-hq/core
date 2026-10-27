/** The page template components of spec §5 (T1–T12; ConversationPage joins T7 and replaces PlaygroundPage once the conversation page moves over). */
export const PAGE_TEMPLATES = [
  "OverviewPage",
  "ListPage",
  "DetailPage",
  "FormPage",
  "SettingsPage",
  "InboxPage",
  "PlaygroundPage",
  "ConversationPage",
  "TracePage",
  "WizardPage",
  "AuthPage",
  "StatusPage",
  "OnboardingPage",
] as const;

export type PageTemplateName = (typeof PAGE_TEMPLATES)[number];
