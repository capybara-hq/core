import { type Directory, type DirectoryMember, definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 测试用最小 `directory@1`：组织级配置给一个假通讯录地址（test/helpers/fake-directory.ts），
 * `listMembers` 按游标 GET `<url>/members?cursor=<c>`（请求头 `x-pid`），非 200 抛错。
 */
const OrgConfig = z.object({ url: z.string().url() });

const directory: Directory = {
  async listMembers({ orgConfig, cursor, signal }) {
    const c = OrgConfig.parse(orgConfig);
    const q = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(`${c.url}/members${q}`, {
      signal,
      headers: { "x-pid": String(process.pid) },
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`directory returned ${res.status}`);
    }
    return (await res.json()) as { members: DirectoryMember[]; next?: string };
  },
};

export default definePlugin({
  name: "dir-mini",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["directory@1"],
  config: { org: OrgConfig },
  setup(ctx) {
    ctx.provide("directory@1", directory);
  },
});
