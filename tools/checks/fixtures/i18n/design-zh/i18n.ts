export type Locale = "zh" | "en";

const zh = {
  "nav.agents": "Agents",
  "nav.catalog": "企业目录",
  "nav.new": "新建 {agent}",
  "subagent.running": "正在运行 {n} 个子智能体",
};

export type DesignKey = keyof typeof zh;

const en: Record<DesignKey, string> = {
  "nav.agents": "Agents",
  "nav.catalog": "Enterprise catalog",
  "nav.new": "New {agent}",
  "subagent.running": "{n} subagents running",
};

export const messages: Record<Locale, Record<DesignKey, string>> = { zh, en };
