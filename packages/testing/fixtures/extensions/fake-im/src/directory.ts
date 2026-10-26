import type { Directory, DirectoryMember } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 组织级配置：假平台上一份通讯录的地址（startFakeChannelServer().book(key).url）。 */
export const FakeImOrgConfig = z.object({ url: z.string().url() });

/**
 * 假 IM 平台的 `directory@1`：`listMembers` 按游标 GET `<url>/members?cursor=<c>`（请求头 `x-pid`），
 * 非 200 抛错（内核把整轮当作不完整，不移除任何人）。dir-mini 复用它。
 */
export const fakeImDirectory: Directory = {
  async listMembers({ orgConfig, cursor, signal }) {
    const c = FakeImOrgConfig.parse(orgConfig);
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
