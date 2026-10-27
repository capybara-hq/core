import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

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
  o: { env?: Record<string, string>; cwd?: string; input?: string | Buffer } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // A command that reads no input gets no stdin pipe: it can exit before a write to its stdin is
    // dispatched, and that write then fails with EPIPE (an uncaught error, seen under load on Linux).
    const p = spawn("git", args, {
      env: gitEnv(o.env),
      cwd: o.cwd ?? tmpdir(),
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stdinError: Error | undefined;
    p.stdout?.on("data", (b: Buffer) => out.push(b));
    p.stderr?.on("data", (b: Buffer) => err.push(b));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString()}`));
      } else if (stdinError !== undefined) {
        // The input was not fully delivered, so the output is not for that input.
        reject(new Error(`git ${args[0]}: writing stdin failed: ${stdinError.message}`));
      } else resolve(Buffer.concat(out).toString("utf8").trim());
    });
    if (o.input !== undefined && p.stdin !== null) {
      p.stdin.on("error", (e) => {
        stdinError = e;
      });
      if (o.input.length === 0) p.stdin.end();
      else p.stdin.end(o.input);
    }
  });
}

/** Starts `git http-backend` as a CGI script for one request (smart HTTP, read-only). */
function spawnCgi(root: string, req: IncomingMessage): ChildProcessWithoutNullStreams {
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
  // http-backend may exit without reading the whole body (a GET, or a request it refuses): the
  // write then fails with EPIPE. Its exit status and output decide the response, not the pipe.
  p.stdin.on("error", () => {});
  req.pipe(p.stdin);
  return p;
}

interface CgiHead {
  status: number;
  headers: Record<string, string>;
  /** Where the body starts in the buffer the head was read from. */
  bodyStart: number;
}

/** The CGI head (`Status:` and the headers) once the blank line after it has arrived. */
function cgiHead(head: Buffer): CgiHead | undefined {
  const crlf = head.indexOf("\r\n\r\n");
  const lf = head.indexOf("\n\n");
  const end = crlf >= 0 ? crlf : lf;
  if (end < 0) return undefined;
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
  return { status, headers, bodyStart: end + (crlf >= 0 ? 4 : 2) };
}

/** Streams http-backend's answer to one request. */
function serveCgi(root: string, req: IncomingMessage, res: ServerResponse): void {
  const p = spawnCgi(root, req);
  // A client that goes away mid-response needs no more output.
  res.on("close", () => {
    if (p.exitCode === null && p.signalCode === null) p.kill();
  });
  let head = Buffer.alloc(0);
  let headDone = false;
  p.stdout.on("data", (chunk: Buffer) => {
    if (headDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const h = cgiHead(head);
    if (h === undefined) return;
    headDone = true;
    res.writeHead(h.status, h.headers);
    res.write(head.subarray(h.bodyStart));
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

/** A whole http-backend answer, for the ref advertisements the server memoizes. */
interface CgiAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** http-backend exited with status 0 (only such answers are kept). */
  ok: boolean;
}

/** Runs http-backend for one request and collects its answer (undefined when it printed none). */
function runCgi(root: string, req: IncomingMessage): Promise<CgiAnswer | undefined> {
  return new Promise((resolve) => {
    const p = spawnCgi(root, req);
    const out: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.on("error", () => resolve(undefined));
    p.on("close", (code) => {
      const all = Buffer.concat(out);
      const h = cgiHead(all);
      resolve(
        h === undefined
          ? undefined
          : {
              status: h.status,
              headers: h.headers,
              body: all.subarray(h.bodyStart),
              ok: code === 0,
            },
      );
    });
  });
}

const NL = Buffer.from("\n");

/** C-style quoting of a fast-import path when it needs it. */
const fastImportPath = (path: string): string =>
  /^"|[\n"\\]/.test(path)
    ? `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
    : path;

/**
 * A fake git host: bare repos in a temp dir, served read-only by the system `git http-backend`
 * (smart HTTP, as CGI) over a loopback http server. Repos allow fetching any reachable commit by sha
 * (`uploadpack.allowReachableSHA1InWant`, as GitHub does). Needs `git` on PATH.
 *
 * Spawning git is what these tests spend their time on, and it slows down most under load, so the
 * server spawns as little as it can while every answer still comes from git: a commit is one
 * `git fast-import`, and a ref advertisement (`GET …/info/refs`) is answered by http-backend once per
 * repo state, then repeated until the next commit to that repo.
 */
export async function startFakeGitServer(): Promise<FakeGitServer> {
  const root = await mkdtemp(join(tmpdir(), "capybara-fake-git-"));
  const requests: FakeGitRequest[] = [];
  let redirect: string | null = null;
  /** Ref advertisements by repo, then by request (path, query and `Git-Protocol`). */
  const advertised = new Map<string, Map<string, CgiAnswer>>();
  /** Bumped by every commit to a repo: an answer read before the commit is not kept. */
  const generation = new Map<string, number>();
  const repoOf = (pathname: string): string | undefined =>
    /^\/([^/]+)\.git\/info\/refs$/.exec(pathname)?.[1];
  const server = createServer((req, res) => {
    const r: FakeGitRequest = { method: req.method ?? "GET", path: req.url ?? "/" };
    if (typeof req.headers.authorization === "string") r.authorization = req.headers.authorization;
    requests.push(r);
    if (redirect !== null) {
      res.writeHead(302, { location: redirect }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const repo = req.method === "GET" ? repoOf(url.pathname) : undefined;
    if (repo === undefined) {
      serveCgi(root, req, res);
      return;
    }
    const key = `${url.pathname}${url.search}|${req.headers["git-protocol"] ?? ""}`;
    const send = (a: CgiAnswer) => res.writeHead(a.status, a.headers).end(a.body);
    const known = advertised.get(repo)?.get(key);
    if (known !== undefined) {
      send(known);
      return;
    }
    const gen = generation.get(repo) ?? 0;
    void runCgi(root, req).then((a) => {
      if (a === undefined) {
        res.writeHead(502).end();
        return;
      }
      if (a.ok && a.status === 200 && (generation.get(repo) ?? 0) === gen) {
        const byKey = advertised.get(repo) ?? new Map<string, CgiAnswer>();
        byKey.set(key, a);
        advertised.set(repo, byKey);
      }
      send(a);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const repoDir = async (repo: string): Promise<string> => {
    if (!REPO_RE.test(repo)) throw new Error(`invalid fake repo name: ${repo}`);
    const dir = join(root, `${repo}.git`);
    if (!existsSync(dir)) {
      await git(["init", "--bare", "--quiet", "--initial-branch=main", dir]);
      await appendFile(join(dir, "config"), "[uploadpack]\n\tallowReachableSHA1InWant = true\n");
    }
    return dir;
  };

  const commit: FakeGitServer["commit"] = async (repo, files, opts = {}) => {
    const gitDir = await repoDir(repo);
    const branch = opts.branch ?? "main";
    const env = { GIT_DIR: gitDir };
    // the whole tree, by path (a later entry for the same path wins, as a later file write did)
    const entries = new Map<string, string>();
    const blobs: Buffer[] = [];
    // mark :1 is the commit; blobs are :2, :3, …
    let mark = 1;
    const inline = (content: string): string => {
      const b = Buffer.from(content, "utf8");
      mark++;
      blobs.push(Buffer.from(`blob\nmark :${mark}\ndata ${b.length}\n`), b, NL);
      return `:${mark}`;
    };
    for (const [path, content] of Object.entries(files)) {
      const p = posix.normalize(path.replace(/^\.\//, ""));
      if (p === "." || p === ".." || p.startsWith("../") || posix.isAbsolute(p)) {
        throw new Error(`fake git path escapes: ${path}`);
      }
      entries.set(p, `M 100644 ${inline(content)} ${fastImportPath(p)}`);
    }
    for (const [path, linkTarget] of Object.entries(opts.symlinks ?? {})) {
      entries.set(path, `M 120000 ${inline(linkTarget)} ${fastImportPath(path)}`);
    }
    for (const [path, sha] of Object.entries(opts.submodules ?? {})) {
      entries.set(path, `M 160000 ${sha} ${fastImportPath(path)}`);
    }
    if (opts.treeDag !== undefined) {
      const { name, fanout, depth } = opts.treeDag;
      let level = await git(["mktree"], { env, input: "" });
      for (let d = 0; d < depth; d++) {
        let lines = "";
        for (let i = 0; i < fanout; i++) lines += `040000 tree ${level}\td${i}\n`;
        level = await git(["mktree"], { env, input: lines });
      }
      entries.set(name, `M 040000 ${level} ${fastImportPath(name)}`);
    }
    const parent = await readFile(join(gitDir, "refs", "heads", branch), "utf8").then(
      (s) => s.trim(),
      () => "",
    );
    const who = `Fake Git <fake-git@example.com> ${Math.floor(Date.now() / 1000)} +0000`;
    const message = Buffer.from(`commit on ${branch}`);
    const lines = [
      `commit refs/heads/${branch}`,
      "mark :1",
      `author ${who}`,
      `committer ${who}`,
      `data ${message.length}`,
      message.toString(),
      ...(parent ? [`from ${parent}`] : []),
      "deleteall",
      ...entries.values(),
      "",
    ];
    if (opts.tag !== undefined) {
      const t = opts.tag;
      if (t.annotated) {
        const m = `tag ${t.name}`;
        lines.push(`tag ${t.name}`, "from :1", `tagger ${who}`, `data ${Buffer.byteLength(m)}`, m);
      } else lines.push(`reset refs/tags/${t.name}`, "from :1", "");
    }
    lines.push("get-mark :1", "done", "");
    const sha = await git(["fast-import", "--quiet", "--force", "--done"], {
      env,
      input: Buffer.concat([...blobs, Buffer.from(lines.join("\n"))]),
    });
    generation.set(repo, (generation.get(repo) ?? 0) + 1);
    advertised.delete(repo);
    return sha;
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
