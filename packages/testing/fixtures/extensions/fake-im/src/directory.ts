import type { Directory, DirectoryMember } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * The directory part of the deployment config: the address of a directory book on the fake
 * platform (startFakeChannelServer().book(key).url). Org-overridable: each org sets its own book
 * in its copy. Unset means the directory is not configured (`configured()` false).
 */
export const FakeImDirectoryConfig = z.object({ directoryUrl: z.string().url().optional() });

/**
 * `directory@1` of the fake IM platform: `listMembers` GETs `<directoryUrl>/members?cursor=<c>`
 * (header `x-pid`) from the effective config it is given, and throws on anything but 200 (the
 * kernel then treats the round as incomplete and removes nobody). `configured()` is true iff
 * `directoryUrl` is set. dir-mini and dir-opt reuse it.
 */
export const fakeImDirectory: Directory = {
  configured: (config) => FakeImDirectoryConfig.safeParse(config).data?.directoryUrl !== undefined,
  async listMembers({ config, cursor, signal }) {
    const url = FakeImDirectoryConfig.parse(config).directoryUrl;
    if (url === undefined) throw new Error("fake-im directory: directoryUrl is not set");
    const q = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(`${url}/members${q}`, {
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
