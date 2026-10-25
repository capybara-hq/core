import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** One request the fake git server received. */
export interface FakeGitRequest {
  method: string;
  /** Path and query, e.g. `/x.git/info/refs?service=git-upload-pack`. */
  path: string;
  /** The `Authorization` header. */
  authorization?: string;
}

/** Entries that are not regular files, for tests of refused trees. */
export interface FakeGitCommitOptions {
  /** Default `main` (the bare repo's HEAD). */
  branch?: string;
  /** Symlink entries (mode 120000): path -> link target. */
  symlinks?: Record<string, string>;
  /** Submodule entries (gitlinks, mode 160000): path -> commit sha (need not exist). */
  submodules?: Record<string, string>;
  /**
   * A tree-only DAG at the top-level directory `name`: T0 is the empty tree and each level holds
   * `fanout` entries all pointing at the level below, `depth` levels deep (few objects, fanout^depth
   * paths).
   */
  treeDag?: { name: string; fanout: number; depth: number };
  /** Also tags the commit (`annotated` creates a tag object; default lightweight). */
  tag?: { name: string; annotated?: boolean };
}

export interface FakeGitServer {
  /** `http://127.0.0.1:<port>/<repo>.git`. */
  url(repo: string): string;
  /**
   * Commits exactly `files` (path -> UTF-8 content; the whole tree, not a diff) on `branch`, whose
   * previous head (if any) is the parent; creates the repo on first use. Returns the commit sha.
   */
  commit(repo: string, files: Record<string, string>, opts?: FakeGitCommitOptions): Promise<string>;
  /** Makes every request answer 302 to `location` (`null` restores it). */
  setRedirect(location: string | null): void;
  /** The requests received, in order. */
  requests: FakeGitRequest[];
  stop(): Promise<void>;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Git runs with no user or system config, so a developer's settings never change the repos. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fake Git",
    GIT_AUTHOR_EMAIL: "fake-git@example.com",
    GIT_COMMITTER_NAME: "Fake Git",
    GIT_COMMITTER_EMAIL: "fake-git@example.com",
    ...extra,
  };
}

function git(
  args: string[],
  o: { env?: Record<string, string>; cwd?: string; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { env: gitEnv(o.env), cwd: o.cwd ?? tmpdir() });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => err.push(b));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString()}`));
    });
    p.stdin.end(o.input ?? "");
  });
}

/** Runs `git http-backend` as a CGI script for one request (smart HTTP, read-only). */
function serveCgi(root: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const env: Record<string, string> = {
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.replace(/^\?/, ""),
    REQUEST_METHOD: req.method ?? "GET",
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_ADDR: "127.0.0.1",
  };
  const len = req.headers["content-length"];
  if (typeof len === "string") env.CONTENT_LENGTH = len;
  const proto = req.headers["git-protocol"];
  if (typeof proto === "string") env.GIT_PROTOCOL = proto;
  const enc = req.headers["content-encoding"];
  if (typeof enc === "string") env.HTTP_CONTENT_ENCODING = enc;
  const p = spawn("git", ["http-backend"], { env: gitEnv(env) });
  req.pipe(p.stdin);
  let head = Buffer.alloc(0);
  let headDone = false;
  p.stdout.on("data", (chunk: Buffer) => {
    if (headDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const crlf = head.indexOf("\r\n\r\n");
    const lf = head.indexOf("\n\n");
    const end = crlf >= 0 ? crlf : lf;
    if (end < 0) return;
    headDone = true;
    const sep = crlf >= 0 ? 4 : 2;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === "status") status = Number.parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + sep));
  });
  p.on("close", () => {
    if (!headDone) res.writeHead(502);
    res.end();
  });
  p.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
}

/**
 * A fake git host: bare repos in a temp dir, served read-only by the system `git http-backend`
 * (smart HTTP, as CGI) over a loopback http server. Repos allow fetching any reachable commit by sha
 * (`uploadpack.allowReachableSHA1InWant`, as GitHub does). Needs `git` on PATH.
 */
export async function startFakeGitServer(): Promise<FakeGitServer> {
  const root = await mkdtemp(join(tmpdir(), "capybara-fake-git-"));
  const requests: FakeGitRequest[] = [];
  let redirect: string | null = null;
  const server = createServer((req, res) => {
    const r: FakeGitRequest = { method: req.method ?? "GET", path: req.url ?? "/" };
    if (typeof req.headers.authorization === "string") r.authorization = req.headers.authorization;
    requests.push(r);
    if (redirect !== null) {
      res.writeHead(302, { location: redirect }).end();
      return;
    }
    serveCgi(root, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const repoDir = async (repo: string): Promise<string> => {
    if (!REPO_RE.test(repo)) throw new Error(`invalid fake repo name: ${repo}`);
    const dir = join(root, `${repo}.git`);
    if (!existsSync(dir)) {
      await git(["init", "--bare", "--quiet", "--initial-branch=main", dir]);
      await git(["config", "uploadpack.allowReachableSHA1InWant", "true"], { cwd: dir });
    }
    return dir;
  };

  const commit: FakeGitServer["commit"] = async (repo, files, opts = {}) => {
    const gitDir = await repoDir(repo);
    const branch = opts.branch ?? "main";
    const work = await mkdtemp(join(tmpdir(), "capybara-fake-git-work-"));
    const scratch = await mkdtemp(join(tmpdir(), "capybara-fake-git-index-"));
    try {
      for (const [path, content] of Object.entries(files)) {
        const target = resolve(work, path);
        if (!target.startsWith(work + sep)) throw new Error(`fake git path escapes: ${path}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const env = {
        GIT_DIR: gitDir,
        GIT_WORK_TREE: work,
        GIT_INDEX_FILE: join(scratch, "index"),
      };
      await git(["add", "-A", "-f", "."], { env, cwd: work });
      for (const [path, linkTarget] of Object.entries(opts.symlinks ?? {})) {
        const blob = await git(["hash-object", "-w", "--stdin"], { env, input: linkTarget });
        await git(["update-index", "--add", "--cacheinfo", `120000,${blob},${path}`], { env });
      }
      for (const [path, sha] of Object.entries(opts.submodules ?? {})) {
        await git(["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`], { env });
      }
      let tree = await git(["write-tree"], { env });
      if (opts.treeDag !== undefined) {
        const { name, fanout, depth } = opts.treeDag;
        let level = await git(["mktree"], { env, input: "" });
        for (let d = 0; d < depth; d++) {
          let lines = "";
          for (let i = 0; i < fanout; i++) lines += `040000 tree ${level}\td${i}\n`;
          level = await git(["mktree"], { env, input: lines });
        }
        const top = await git(["ls-tree", tree], { env });
        const input = `${top === "" ? "" : `${top}\n`}040000 tree ${level}\t${name}\n`;
        tree = await git(["mktree"], { env, input });
      }
      const parent = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], {
        env,
      }).catch(() => "");
      const sha = await git(
        ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `commit on ${branch}`],
        { env },
      );
      await git(["update-ref", `refs/heads/${branch}`, sha], { env });
      if (opts.tag !== undefined) {
        const t = opts.tag;
        if (t.annotated) await git(["tag", "-a", t.name, sha, "-m", `tag ${t.name}`], { env });
        else await git(["update-ref", `refs/tags/${t.name}`, sha], { env });
      }
      return sha;
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  };

  return {
    url: (repo) => `http://127.0.0.1:${port}/${repo}.git`,
    commit,
    setRedirect: (l) => {
      redirect = l;
    },
    requests,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
