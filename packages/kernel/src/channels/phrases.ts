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
  /** 卡片操作：点击者不是审批人 / 不是提问的发起人（或请求不在该组织）。 */
  cannotHandle: { zh: "你不能处理这条请求。", en: "You can't handle this request." },
  /** 卡片操作：请求已被处理、已过期或已取消。 */
  alreadyHandled: {
    zh: "这条请求已经处理过了。",
    en: "This request has already been handled.",
  },
  /** 卡片操作：回答不符合表单，或审批范围不允许。 */
  invalidAction: {
    zh: "无法完成这个操作，请到网页上处理。",
    en: "That action isn't valid here. Please handle it on the web.",
  },
  /** 审批卡片的标题与随附文本。 */
  approvalTitle: { zh: "需要你的批准", en: "Approval required" },
  /** 提问卡片的随附文本。 */
  questionTitle: { zh: "需要你的回答", en: "Your input is needed" },
  /** 连接卡片的随附文本。 */
  connectTitle: { zh: "需要先完成连接器授权", en: "A connector needs to be connected first" },
  /** 部署未配置 http.publicUrl，无法给出网页链接与卡片时的退回文本。 */
  handleOnWeb: {
    zh: "有一条请求需要你到 Capybara 网页上处理。",
    en: "A request is waiting for you in Capybara on the web.",
  },
  /**
   * Phase D: `/name args` named an invocable skill, but the kernel refused to render it
   * (`validation_failed`: arguments or the rendered skill over the limits); the message was posted
   * as typed instead (batch 4 review m2).
   */
  skillNotRun: {
    zh: "技能没有运行：参数或技能内容过长。你的消息已按普通文本发送。",
    en: "The skill was not run: its arguments or instructions are too long. Your message was sent as plain text.",
  },
  /** 运行被中止（收尾挂着的草稿时附在已有文本之后）。 */
  runStopped: { zh: "已停止。", en: "Stopped." },
  /** 运行失败。 */
  runFailed: {
    zh: "抱歉，出错了，请稍后再试。",
    en: "Sorry, something went wrong. Please try again later.",
  },
} as const satisfies Record<string, Record<ChannelLocale, string>>;

export type ChannelPhrase = keyof typeof CHANNEL_PHRASES;

/** 取一条话术。 */
export function phrase(key: ChannelPhrase, locale: ChannelLocale): string {
  return CHANNEL_PHRASES[key][locale];
}
