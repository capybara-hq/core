export type Locale = "zh" | "en";

const zh = {
  "theme.dark": "深色",
  "theme.light": "浅色",
  "theme.toggle": "切换主题",
  "field.reset": "↺ 恢复默认",
  "field.optional": "可选",
};

export type DesignKey = keyof typeof zh;

const en: Record<DesignKey, string> = {
  "theme.dark": "Dark",
  "theme.light": "Light",
  "theme.toggle": "Toggle theme",
  "field.reset": "↺ Reset to default",
  "field.optional": "optional",
};

export const messages: Record<Locale, Record<DesignKey, string>> = { zh, en };
