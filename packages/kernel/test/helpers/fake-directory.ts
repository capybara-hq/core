import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DirectoryMember } from "@capybara-hq/plugin-sdk";

/** 一份假通讯录（按路径前缀 `/d/<key>` 区分，供测试插件 dir-mini 读取）。 */
export interface FakeDirectoryBook {
  /** dir-mini 的组织级配置 `url`。 */
  url: string;
  members: DirectoryMember[];
  /** 每页条数（默认 100）。 */
  pageSize: number;
  /** 第几页（从 0 计）返回 500；null 不失败。 */
  failOnPage: number | null;
  /** 给了就让第一页（不带游标的请求）等它 resolve 再返回。 */
  hold: Promise<void> | null;
  /** 每次请求的页号与发起进程 pid。 */
  requests: { page: number; pid: number }[];
  /** 整轮同步开始的次数（不带游标的请求数）。 */
  starts(): number;
}

export interface FakeDirectory {
  book(key: string): FakeDirectoryBook;
  stop(): Promise<void>;
}

/** 通讯录成员（租户 t1；邮箱缺省 `<id>@corp.example`、已验证）。 */
export const person = (
  externalId: string,
  over: Partial<DirectoryMember> = {},
): DirectoryMember => ({
  externalId,
  tenantId: "t1",
  email: `${externalId}@corp.example`,
  emailVerified: true,
  displayName: externalId,
  active: true,
  ...over,
});

/** 假通讯录平台：分页返回成员，可让某一页失败、让第一页挂起，记录每次请求。 */
export async function startFakeDirectory(): Promise<FakeDirectory> {
  const books = new Map<string, FakeDirectoryBook>();
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", "http://x");
      const m = /^\/d\/([^/]+)\/members$/.exec(u.pathname);
      const b = m ? books.get(m[1] as string) : undefined;
      if (!b) {
        res.writeHead(404).end();
        return;
      }
      const cursor = u.searchParams.get("cursor");
      const page = cursor === null ? 0 : Number(cursor);
      b.requests.push({ page, pid: Number(req.headers["x-pid"]) });
      if (page === 0 && b.hold) await b.hold;
      if (b.failOnPage === page) {
        res.writeHead(500).end();
        return;
      }
      const start = page * b.pageSize;
      const members = b.members.slice(start, start + b.pageSize);
      const more = start + b.pageSize < b.members.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ members, ...(more && { next: String(page + 1) }) }));
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    book(key) {
      let b = books.get(key);
      if (!b) {
        const requests: { page: number; pid: number }[] = [];
        b = {
          url: `${base}/d/${key}`,
          members: [],
          pageSize: 100,
          failOnPage: null,
          hold: null,
          requests,
          starts: () => requests.filter((r) => r.page === 0).length,
        };
        books.set(key, b);
      }
      return b;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
