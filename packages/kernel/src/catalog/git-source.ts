import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import git, { type GitHttpRequest, type GitHttpResponse, type HttpClient } from "isomorphic-git";
import { NetDeniedError, type NetPolicy } from "../net/public-address.js";
import { NetBodyTooLargeError, safeFetch } from "../net/safe-fetch.js";
import {
  type MarketplaceNetCode,
  marketplaceNetCode,
  marketplaceUrlProblem,
} from "./marketplace-fetch.js";

/**
 * Reading plugins from git (spec §5.1, §5.2; Decision 2): isomorphic-git (pure JS, any smart-HTTP
 * host) over the kernel's public-address network layer. The repo is hostile input:
 * - https smart HTTP only (`GET info/refs` + `POST git-upload-pack`), each request through
 *   `net/safeFetch` (public addresses, pinned connection, no redirects); the token goes only to
 *   `tokenOrigin`;
 * - one commit, depth 1, no tags, no submodules (never fetched); the pack is at most `maxBytes`;
 * - before isomorphic-git indexes the pack (which inflates every object), the pack is scanned with
 *   bounded inflation: at most {@link GIT_LIMITS}`.maxObjects` objects and 4 × `maxBytes` of declared
 *   content in all, so a deflate bomb is refused before it is expanded;
 * - files are read from the object store (`readTree` / `readBlob`), never checked out; symlinks and
 *   submodule entries under `path` are refused; at most 5000 files and 4 × `maxBytes`; LFS pointer
 *   files are ordinary files;
 * - the object store is a temp dir removed after each operation; 120 s per operation.
 */

export const GIT_LIMITS = {
  maxFiles: 5000,
  /** Objects in one pack (a depth-1 commit: the commit, its trees and blobs). */
  maxObjects: 20_000,
  /** Unpacked bytes (pack content and files read) at most this × `maxBytes`. */
  unpackedFactor: 4,
  timeoutMs: 120_000,
} as const;

export type GitLocation = { url: string; ref?: string; commit?: string; path?: string };

export type GitOptions = {
  net: NetPolicy;
  token?: string;
  /** The token is sent only to this origin (the marketplace URL's). */
  tokenOrigin?: string;
  signal: AbortSignal;
  /** `packages.maxBytes`: the largest pack. */
  maxBytes: number;
};

export type GitSourceErrorCode =
  | "marketplace.git_failed"
  | "marketplace.git_too_large"
  | "marketplace.git_unsupported_entry";

/** A git read failed. English message without the token; `netCode` when the network rules refused. */
export class GitSourceError extends Error {
  readonly netCode: MarketplaceNetCode | undefined;
  constructor(
    readonly code: GitSourceErrorCode,
    message: string,
    options?: { cause?: unknown; netCode?: MarketplaceNetCode },
  ) {
    super(message, options);
    this.name = "GitSourceError";
    this.netCode = options?.netCode;
  }
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const SHORTHAND_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;

/** `owner/repo` -> `https://github.com/owner/repo.git`; anything else is returned unchanged. */
export function expandGitUrl(input: string): string {
  const m = SHORTHAND_RE.exec(input);
  if (m === null) return input;
  const repo = (m[2] as string).replace(/\.git$/, "");
  if (repo === "" || repo === "." || repo === "..") return input;
  return `https://github.com/${m[1]}/${repo}.git`;
}

const failed = (message: string, cause?: unknown) =>
  new GitSourceError("marketplace.git_failed", message, cause === undefined ? {} : { cause });
const tooLarge = (message: string) => new GitSourceError("marketplace.git_too_large", message);
const unsupported = (message: string) =>
  new GitSourceError("marketplace.git_unsupported_entry", message);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  if (body !== undefined) for await (const c of body) parts.push(c);
  return Buffer.concat(parts);
}

/** One operation: its signal (caller's + 120 s), the http client, and what went wrong on the wire. */
interface Op {
  signal: AbortSignal;
  http: HttpClient;
  /** The url without a trailing slash. */
  url: string;
  /** Set when a response body went over `maxBytes`. */
  state: { overLimit: boolean };
}

function startOp(loc: GitLocation, o: GitOptions): Op {
  const problem = marketplaceUrlProblem(loc.url, o.net.allowInsecureLoopback);
  if (problem !== null) throw failed(`invalid git URL: ${problem}`);
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(GIT_LIMITS.timeoutMs)]);
  const state = { overLimit: false };
  const auth =
    o.token === undefined
      ? undefined
      : `Basic ${Buffer.from(`x-access-token:${o.token}`).toString("base64")}`;
  const http: HttpClient = {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const target = new URL(req.url);
      const headers: Record<string, string> = { ...req.headers };
      delete headers.authorization;
      delete headers.Authorization;
      if (auth !== undefined && o.tokenOrigin === target.origin) headers.authorization = auth;
      const method = req.method ?? "GET";
      const body = req.body === undefined ? undefined : await collect(req.body);
      const res = await safeFetch(
        target.href,
        { method, headers, ...(body !== undefined && { body }), signal },
        o.net,
        { maxBytes: o.maxBytes },
      );
      const stream = res.body;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (stream === null) return;
        try {
          for await (const c of stream) yield c;
        } catch (e) {
          if (e instanceof NetBodyTooLargeError) state.overLimit = true;
          throw e;
        }
      }
      return {
        url: target.href,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: Object.fromEntries(res.headers),
        body: chunks(),
      };
    },
  };
  return { signal, http, url: loc.url.replace(/\/+$/, ""), state };
}

/** Maps anything thrown during an operation to a {@link GitSourceError} (the caller's abort stays). */
function mapError(e: unknown, op: Op, o: GitOptions, what: string): unknown {
  if (o.signal.aborted) return o.signal.reason;
  if (e instanceof GitSourceError) return e;
  if (op.state.overLimit || e instanceof NetBodyTooLargeError) {
    return tooLarge(`${what}: the git server sent more than ${o.maxBytes} bytes`);
  }
  if (op.signal.aborted) {
    return failed(`${what}: timed out after ${GIT_LIMITS.timeoutMs / 1000} s`, e);
  }
  if (e instanceof NetDeniedError) {
    const netCode = marketplaceNetCode(e);
    return new GitSourceError("marketplace.git_failed", `${what}: ${e.message}`, {
      cause: e,
      ...(netCode !== undefined && { netCode }),
    });
  }
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof NetDeniedError) return mapError(cause, op, o, what);
  const status = (e as { data?: { statusCode?: unknown } })?.data?.statusCode;
  if (typeof status === "number") return failed(`${what}: the git server answered ${status}`, e);
  return failed(`${what}: ${errMsg(e)}`, e);
}

/**
 * The commit to read (40 lower-case hex): `commit` when given (it wins over `ref`), otherwise the
 * head of `ref` (a branch, a tag or a full `refs/…` name) or of the remote HEAD.
 */
export async function resolveGitCommit(loc: GitLocation, o: GitOptions): Promise<string> {
  if (loc.commit !== undefined) {
    if (!SHA_RE.test(loc.commit)) throw failed(`"${loc.commit}" is not a full commit sha`);
    return loc.commit.toLowerCase();
  }
  const op = startOp(loc, o);
  const what = `cannot list the refs of ${op.url}`;
  let refs: { ref: string; oid: string; peeled?: string | undefined }[];
  try {
    const info = await git.getRemoteInfo2({ http: op.http, url: op.url, protocolVersion: 1 });
    refs = info.refs ?? [];
  } catch (e) {
    throw mapError(e, op, o, what);
  }
  const ref = loc.ref ?? "HEAD";
  if (SHA_RE.test(ref)) return ref.toLowerCase();
  const names =
    ref === "HEAD"
      ? ["HEAD"]
      : ref.startsWith("refs/")
        ? [ref]
        : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const name of names) {
    const r = refs.find((x) => x.ref === name);
    if (r !== undefined) {
      const oid = r.peeled ?? r.oid;
      if (SHA_RE.test(oid)) return oid.toLowerCase();
    }
  }
  throw failed(`${op.url}: ref "${ref}" not found`);
}

/** The delta's result size (the second varint of the delta header). */
function deltaTargetSize(delta: Buffer): number {
  let pos = 0;
  const varint = () => {
    let n = 0;
    let shift = 0;
    let c: number;
    do {
      if (pos >= delta.length || shift > 49) throw failed("corrupt git pack: bad delta header");
      c = delta[pos++] as number;
      n += (c & 0x7f) * 2 ** shift;
      shift += 7;
    } while (c & 0x80);
    return n;
  };
  varint();
  return varint();
}

/**
 * Walks a pack (v2/v3) with bounded inflation before anything else expands it: object count and the
 * declared content sizes (objects, and delta results) must fit; an object that inflates beyond its
 * declared size is refused.
 */
export function scanPack(pack: Uint8Array, maxUnpacked: number): void {
  const b = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (b.length < 32 || b.toString("latin1", 0, 4) !== "PACK") throw failed("not a git pack");
  const count = b.readUInt32BE(8);
  if (count > GIT_LIMITS.maxObjects) {
    throw tooLarge(`the git pack holds ${count} objects; at most ${GIT_LIMITS.maxObjects}`);
  }
  const end = b.length - 20;
  let pos = 12;
  let total = 0;
  const truncated = () => failed("corrupt git pack: truncated");
  for (let i = 0; i < count; i++) {
    if (pos >= end) throw truncated();
    let c = b[pos++] as number;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      if (pos >= end || shift > 49) throw truncated();
      c = b[pos++] as number;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (type === 6) {
      do {
        if (pos >= end) throw truncated();
        c = b[pos++] as number;
      } while (c & 0x80);
    } else if (type === 7) pos += 20;
    else if (type < 1 || type > 4) throw failed(`corrupt git pack: object type ${type}`);
    if (size > maxUnpacked - total) {
      throw tooLarge(`the git content is larger than ${maxUnpacked} bytes unpacked`);
    }
    let out: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      out = inflateSync(b.subarray(pos, end), {
        info: true,
        maxOutputLength: Math.max(size, 1),
      } as never) as unknown as typeof out;
    } catch (e) {
      throw failed(`corrupt git pack: ${errMsg(e)}`, e);
    }
    if (out.buffer.length !== size) throw failed("corrupt git pack: object size mismatch");
    pos += out.engine.bytesWritten;
    total += type >= 6 ? deltaTargetSize(out.buffer) : size;
    if (total > maxUnpacked) {
      throw tooLarge(`the git content is larger than ${maxUnpacked} bytes unpacked`);
    }
  }
}

const PACK_FILE_RE = /[/\\]objects[/\\]pack[/\\]pack-[0-9a-f]*\.pack$/;

/** node fs for isomorphic-git, with the pack scanned before it is written (and then indexed). */
function scanningFs(maxUnpacked: number) {
  // isomorphic-git retries a failed write after creating the directory: scan each pack once
  const verdicts = new WeakMap<Uint8Array, unknown>();
  const scan = (data: Uint8Array) => {
    if (!verdicts.has(data)) {
      try {
        scanPack(data, maxUnpacked);
        verdicts.set(data, null);
      } catch (e) {
        verdicts.set(data, e);
      }
    }
    const verdict = verdicts.get(data);
    if (verdict !== null) throw verdict;
  };
  return {
    promises: {
      ...fsp,
      writeFile: (async (path: string, data: string | Uint8Array, opts?: unknown) => {
        if (PACK_FILE_RE.test(path) && typeof data !== "string") scan(data);
        return fsp.writeFile(path, data, opts as never);
      }) as typeof fsp.writeFile,
    },
  };
}

/** `path` as segments ([] = the repo root); undefined when it is not a safe relative path. */
function pathSegments(path: string | undefined): string[] | undefined {
  if (path === undefined) return [];
  let p = path;
  if (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/$/, "");
  if (p === "" || p === ".") return [];
  const segs = p.split("/");
  return segs.every(
    (s) => s !== "" && s !== "." && s !== ".." && !s.includes("\\") && !s.includes("\0"),
  )
    ? segs
    : undefined;
}

/**
 * The files under `path` at `commit` (paths relative to `path`, `/`-separated, sorted). Throws
 * {@link GitSourceError}: `marketplace.git_failed` (network, server, missing commit or path),
 * `marketplace.git_too_large` (limits), `marketplace.git_unsupported_entry` (symlink, submodule).
 */
export async function readGitTree(
  loc: GitLocation & { commit: string },
  o: GitOptions,
): Promise<Map<string, Uint8Array>> {
  if (!SHA_RE.test(loc.commit)) throw failed(`"${loc.commit}" is not a full commit sha`);
  const commit = loc.commit.toLowerCase();
  const segs = pathSegments(loc.path);
  if (segs === undefined) throw failed(`invalid path "${loc.path}" in the repository`);
  const op = startOp(loc, o);
  const what = `cannot read ${op.url} at ${commit.slice(0, 12)}`;
  const maxUnpacked = GIT_LIMITS.unpackedFactor * o.maxBytes;
  const fs = scanningFs(maxUnpacked);
  const cache = {};
  const gitdir = await fsp.mkdtemp(join(tmpdir(), "capybara-git-"));
  try {
    await git.init({ fs, gitdir, bare: true });
    // fetch needs a remote with a refspec; the commit is fetched by sha and matches no refspec
    await git.addRemote({ fs, gitdir, remote: "origin", url: op.url });
    const res = await git.fetch({
      fs,
      http: op.http,
      gitdir,
      cache,
      url: op.url,
      ref: commit,
      singleBranch: true,
      depth: 1,
      tags: false,
    });
    if (res.fetchHead !== commit) throw failed(`${what}: the server sent another commit`);
    op.signal.throwIfAborted();
    const { commit: c } = await git.readCommit({ fs, gitdir, oid: commit, cache });
    let tree = c.tree;
    const shown: string[] = [];
    for (const seg of segs) {
      shown.push(seg);
      const { tree: entries } = await git.readTree({ fs, gitdir, oid: tree, cache });
      const e = entries.find((x) => x.path === seg);
      if (e === undefined) throw failed(`${what}: ${shown.join("/")} not found`);
      if (e.mode === "120000") throw unsupported(`${shown.join("/")} is a symlink`);
      if (e.type === "commit") throw unsupported(`${shown.join("/")} is a submodule`);
      if (e.type !== "tree") throw failed(`${what}: ${shown.join("/")} is not a directory`);
      tree = e.oid;
    }
    const files = new Map<string, Uint8Array>();
    let bytes = 0;
    const walk = async (oid: string, prefix: string): Promise<void> => {
      const { tree: entries } = await git.readTree({ fs, gitdir, oid, cache });
      for (const e of entries) {
        const name = e.path;
        if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
          throw unsupported(`invalid entry name ${JSON.stringify(name)} in ${prefix || "."}`);
        }
        const p = prefix === "" ? name : `${prefix}/${name}`;
        if (e.type === "commit") throw unsupported(`${p} is a submodule`);
        if (e.mode === "120000") throw unsupported(`${p} is a symlink`);
        if (e.type === "tree") {
          await walk(e.oid, p);
          continue;
        }
        if (e.type !== "blob") throw unsupported(`${p} is a ${e.type}`);
        if (files.size >= GIT_LIMITS.maxFiles) {
          throw tooLarge(`more than ${GIT_LIMITS.maxFiles} files`);
        }
        const { blob } = await git.readBlob({ fs, gitdir, oid: e.oid, cache });
        bytes += blob.byteLength;
        if (bytes > maxUnpacked) throw tooLarge(`the files are larger than ${maxUnpacked} bytes`);
        files.set(p, blob);
        op.signal.throwIfAborted();
      }
    };
    await walk(tree, "");
    return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  } catch (e) {
    throw mapError(e, op, o, what);
  } finally {
    await fsp.rm(gitdir, { recursive: true, force: true });
  }
}
