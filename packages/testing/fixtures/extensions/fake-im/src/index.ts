import {
  defineExtension,
  secret,
  ToolError,
  type ToolHandler,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { makeFakeImChannel } from "./channel.js";
import { FakeImOrgConfig, fakeImDirectory } from "./directory.js";
import { fakeImIdentitySource } from "./identity.js";

export { FakeImConnection, fakeImWebhook, makeFakeImChannel } from "./channel.js";
export { FakeImOrgConfig, fakeImDirectory } from "./directory.js";
export { fakeImIdentitySource } from "./identity.js";

/** 部署级配置：平台地址与登录用的 OAuth 客户端（clientSecret 走密钥存储）。 */
const Deployment = z.object({
  platformUrl: z.string().url(),
  tenant: z.string().min(1).default("t1"),
  clientId: z.string().min(1),
  clientSecret: secret(z.string().min(1)),
});
export type FakeImDeployment = z.infer<typeof Deployment>;

const PostInput = z.object({ text: z.string().min(1).max(500) });

/** 写工具：在平台上发一条公告。默认策略 ask（每次调用都要发起人批准）。 */
const POST_SPEC: ToolSpec = {
  name: "post_announcement",
  description:
    "Post an announcement to the company-wide channel on the IM platform. Everyone in the " +
    "company sees it, so only use it when the user explicitly asks to announce something.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 500, description: "Announcement text." },
    },
    required: ["text"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  defaultPolicy: "ask",
};

const postHandler =
  (config: () => FakeImDeployment): ToolHandler =>
  async (input, ctx) => {
    const parsed = PostInput.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("Invalid input: pass a non-empty text of at most 500 characters.");
    }
    const res = await fetch(`${config().platformUrl}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pid": String(process.pid) },
      body: JSON.stringify({ text: parsed.data.text, conversationId: ctx.conversationId }),
      signal: ctx.signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new ToolError("The IM platform rejected the announcement; retry later.", {
        kind: "unavailable",
      });
    }
    const { id } = (await res.json()) as { id: string };
    return { content: [{ type: "text", text: `Announcement posted (${id}).` }] };
  };

/**
 * 假 IM 平台的完整测试插件（连 `@capybara-hq/testing` 的 startFakeChannelServer）：
 * `channel@1`（机器人）+ `identity-source@1`（登录）+ `directory@1`（通讯录），另带一个默认需要批准的写工具。
 * 三处的身份源键都是 `fake-im:<租户>`，同一个人只对应一行身份。T15–T18 的真实渠道插件照这个形状写。
 */
export default defineExtension({
  name: "fake-im",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1", "identity-source@1", "directory@1"],
  permissions: { tools: ["post_announcement"] },
  config: { deployment: Deployment, org: FakeImOrgConfig },
  setup(ctx) {
    const config = () => Deployment.parse(ctx.config);
    ctx.provide(
      "channel@1",
      makeFakeImChannel({ cards: true, edit: true, threads: true }, { webhook: true }),
    );
    ctx.provide("identity-source@1", fakeImIdentitySource);
    ctx.provide("directory@1", fakeImDirectory);
    ctx.tools.register(POST_SPEC, postHandler(config));
  },
});
