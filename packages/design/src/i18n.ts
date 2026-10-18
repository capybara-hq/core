export type Locale = "zh" | "en";

const zh = {
  "theme.dark": "深色",
  "theme.light": "浅色",
  "theme.toggle": "切换主题",
};

export type DesignKey = keyof typeof zh;

const en: Record<DesignKey, string> = {
  "theme.dark": "Dark",
  "theme.light": "Light",
  "theme.toggle": "Toggle theme",
};

export const messages: Record<Locale, Record<DesignKey, string>> = { zh, en };
