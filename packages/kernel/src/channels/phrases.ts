/** 组织默认语言（`orgs.settings.locale`）。 */
export type ChannelLocale = "zh" | "en";

/**
 * 机器人在 IM 里说的固定话术（全部集中在这里，zh / en 同步）：按连接所属组织的默认语言选择。
 * 模型回复不经过这里，原样转换为 IM 富文本、不翻译。
 */
export const CHANNEL_PHRASES = {
  /** 私聊 `/new` 之后。 */
  newConversation: { zh: "已开始新对话", en: "Started a new conversation." },
  /** 未绑定的人在私聊里发消息：附绑定卡片。 */
  bindPrompt: {
    zh: "请先绑定你的 Capybara 账号，再与我对话。",
    en: "Please link your Capybara account before chatting with me.",
  },
  /** 未绑定的人在群里 @ 机器人：绑定链接只在私聊里发（群里谁都能点）。 */
  bindInDm: {
    zh: "请先私聊我，绑定你的 Capybara 账号。",
    en: "Please send me a direct message to link your Capybara account first.",
  },
  /** 无法生成绑定链接（部署未配置 http.publicUrl）。 */
  bindUnavailable: {
    zh: "暂时无法识别你的身份，请联系管理员。",
    en: "I can't identify you yet. Please contact an administrator.",
  },
  /** 已绑定账号但不是该组织成员。 */
  notMember: {
    zh: "你的账号不是该组织的成员，请联系管理员。",
    en: "Your account is not a member of this organization. Please contact an administrator.",
  },
  /** 匿名策略下，连接绑定的 agent 不是全组织可见。 */
  anonymousNotAllowed: {
    zh: "此助手不对匿名访客开放，请联系管理员。",
    en: "This assistant is not available to anonymous guests. Please contact an administrator.",
  },
  /** 连接绑定的 agent 对此人不可用（可见范围不含此人、已删除）。 */
  agentUnavailable: {
    zh: "你无权使用此助手，请联系管理员。",
    en: "You don't have access to this assistant. Please contact an administrator.",
  },
} as const satisfies Record<string, Record<ChannelLocale, string>>;

export type ChannelPhrase = keyof typeof CHANNEL_PHRASES;

/** 取一条话术。 */
export function phrase(key: ChannelPhrase, locale: ChannelLocale): string {
  return CHANNEL_PHRASES[key][locale];
}
