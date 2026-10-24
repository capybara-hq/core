import { type Directory, defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { fakeImDirectory } from "../fake-im/index.js";

/** 组织级配置可不填（只用插件别的能力时）：`url` 缺省即「通讯录未配置」。 */
const OrgConfig = z.object({ url: z.string().url().optional() });

const directory: Directory = {
  configured: (orgConfig) => OrgConfig.safeParse(orgConfig).data?.url !== undefined,
  listMembers: (args) => fakeImDirectory.listMembers(args),
};

/**
 * Ruling A28 测试插件：`directory@1` 实现了可选的 `configured`；组织级配置 `{ url? }` 没填时内核静默跳过
 * （不扫描、不投递、不审计），手动同步 409 `directory.not_configured`。身份源键 `dir-opt:<租户>`。
 */
export default defineExtension({
  name: "dir-opt",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["directory@1"],
  config: { org: OrgConfig },
  setup(ctx) {
    ctx.provide("directory@1", directory);
  },
});
