import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 可编程的假 E2B（`plugins/sandbox-e2b` 测试用），协议按 `e2b` JS SDK 2.58.0 与 E2B 文档（2026-10-21 核实）：
 *
 * - **控制面 API**（请求头 `X-API-KEY`，不符 → 401 `{code, message}`）：
 *   `POST /v2/sandboxes`（建沙箱，回 201 `{sandboxID, templateID, envdVersion, envdAccessToken, domain}`）、
 *   `GET /v2/sandboxes?metadata=<urlencoded k=v>&state=running,paused&limit=&nextToken=`（按元数据列出，
 *   分页游标在响应头 `x-next-token`）、`POST /v2/sandboxes/{id}/connect`（运行中 200、暂停的恢复后 201、
 *   不存在 404；`timeout` 只延长不缩短）、`POST /sandboxes/{id}/pause`（204；已暂停 409；不存在 404）、
 *   `DELETE /sandboxes/{id}`（204；不存在 404）。
 * - **envd**（同一个地址；按请求头 `E2b-Sandbox-Id` 路由，`X-Access-Token` 须与建沙箱时给的一致；沙箱不存在或
 *   已暂停时与 E2B 的边缘代理一样回 502）：`POST /files?path=&username=`（multipart 字段 `file`）、
 *   Connect 协议的 `POST /process.Process/Start`（`application/connect+json` 服务端流：start / data / end 事件，
 *   结尾帧 flags `0x02`）与 `POST /process.Process/SendSignal`（一元 JSON，按 pid 杀进程组；不存在 404
 *   `{code: "not_found"}`）。用户来自 `Authorization: Basic base64(<user>:)`（命令）或 `username`（上传）。
 *
 * **命令真的在本机跑**：每个沙箱一个临时目录作根，参数、工作目录、环境变量里以 `/workspace`、`/skills`、`/tmp`、
 * `/opt/capybara` 开头的路径映射到根下；`setsid` / `runuser` 由垫片代替（只 exec 后面的命令，不切换用户——
 * 本机只有一个用户，权限隔离测不了，测试改为核对请求里的用户）。进程以新会话启动（与 setsid 等价），
 * 客户端断开**不会**结束进程（与 envd 一致），只有 SendSignal、杀进程脚本或删沙箱才会。
 *
 * `connect` 带 `memory: false`（SDK 的 `onResume: "reboot"`）时结束该沙箱的全部进程（冷启动）。
 * SendSignal 只杀指定进程（不是进程组）。
 *
 * {@link FakeE2BServer.failNext} 让匹配的下一个请求返回指定状态；{@link FakeE2BServer.hangNext} 让它一直不回
 * （测中止）；{@link FakeE2BServer.expire} 让沙箱直接消失（过期 / 被别处删掉）。
 */

export interface FakeE2BOptions {
  /** 期望的 API key（默认随机生成，见 {@link FakeE2BServer.apiKey}）。 */
  apiKey?: string;
  /** 列表接口每页条数（默认 100；测分页时调小）。 */
  pageSize?: number;
  /** create / connect 返回的沙箱 `domain`（默认 null，即用客户端配置的域名）。 */
  domain?: string | null;
}

export interface FakeE2BSandbox {
  id: string;
  templateID: string;
  metadata: Record<string, string>;
  state: "running" | "paused";
  /** 当前的超时（秒）：建沙箱时给的，connect 只会把它调大。 */
  timeout: number;
  autoPause: boolean;
  /** 建沙箱请求体里的出站设置（原样记录）。 */
  allowInternetAccess?: boolean;
  network?: unknown;
  envdAccessToken: string;
  /** 本机上的根目录。 */
  root: string;
}

/** 服务收到的一次请求。 */
export interface FakeE2BCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** JSON 请求体（Connect 流请求为解出的第一条消息；上传为 null）。 */
  body: unknown;
  /** envd 请求：目标沙箱。 */
  sandboxId?: string;
  /** envd 请求：以哪个用户（Basic 认证或 `username`）。 */
  user?: string | undefined;
}

export interface FakeE2BMatch {
  method?: string;
  path: RegExp;
  /** 再按请求细看（Connect 流请求的 `body` 是解出的第一条消息）。 */
  when?: (call: FakeE2BCall) => boolean;
}

export interface FakeE2BServer {
  /** 控制面 API 与 envd 共用的地址 `http://127.0.0.1:<port>`。 */
  url: string;
  apiKey: string;
  sandboxes: Map<string, FakeE2BSandbox>;
  calls: FakeE2BCall[];
  /**
   * 下一个匹配的请求回 `status`：默认 E2B 的错误格式 JSON `{code: status, message}`；`raw` 时回纯文本
   * （模拟前面的代理 / 错配地址回的裸错误）。
   */
  failNext(match: FakeE2BMatch, status: number, message?: string, opts?: { raw?: boolean }): void;
  /** 以 `memory: false` connect（冷启动，进程全部结束）的次数，按沙箱 id。 */
  reboots: Map<string, number>;
  /** 下一个匹配的请求一直不回，直到客户端断开。 */
  hangNext(match: FakeE2BMatch): void;
  /** 沙箱直接消失（杀掉它的进程、删掉根目录）。 */
  expire(id: string): Promise<void>;
  /** 沙箱内路径在本机上的位置。 */
  hostPath(id: string, sandboxPath: string): string;
  /** 沙箱里还在跑的进程（由 Start 启动、尚未退出的）。 */
  running(id: string): { pid: number; args: string[] }[];
  /** 进程组是否还有存活的进程（含被杀进程脚本漏掉的子进程）。 */
  alive(pid: number): boolean;
  close(): Promise<void>;
}

const ROOT_DIRS = ["/workspace", "/skills", "/tmp", "/opt/capybara"];
const PATH_RE = /(^|[\s'"=:>(])(\/workspace|\/skills|\/tmp|\/opt\/capybara)(?=\/|$|[\s'";)|&])/g;

const RUNUSER_SHIM = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -u|-g) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec "$@"
`;
const SETSID_SHIM = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -w|-f|-c|--wait|--fork|--ctty) shift ;;
    *) break ;;
  esac
done
exec "$@"
`;

interface Proc {
  pid: number;
  args: string[];
  child: ChildProcess;
}

function envelope(flags: number, msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(json.byteLength, 1);
  return Buffer.concat([head, json]);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body?: unknown, headers = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));
}

/** 起一个假 E2B。 */
export async function startFakeE2B(opts: FakeE2BOptions = {}): Promise<FakeE2BServer> {
  const apiKey = opts.apiKey ?? `e2b_${randomBytes(16).toString("hex")}`;
  const pageSize = opts.pageSize ?? 100;
  const base = await mkdtemp(join(tmpdir(), "fake-e2b-"));
  const shims = join(base, "bin");
  await mkdir(shims, { recursive: true });
  await writeFile(join(shims, "runuser"), RUNUSER_SHIM);
  await writeFile(join(shims, "setsid"), SETSID_SHIM);
  await chmod(join(shims, "runuser"), 0o755);
  await chmod(join(shims, "setsid"), 0o755);

  const sandboxes = new Map<string, FakeE2BSandbox>();
  const procs = new Map<string, Proc[]>();
  const calls: FakeE2BCall[] = [];
  const fails: { match: FakeE2BMatch; status: number; message: string; raw: boolean }[] = [];
  const reboots = new Map<string, number>();
  const hangs: FakeE2BMatch[] = [];
  const hanging = new Set<ServerResponse>();

  const matches = (m: FakeE2BMatch, call: FakeE2BCall) =>
    (m.method === undefined || m.method === call.method) &&
    m.path.test(call.path) &&
    (m.when === undefined || m.when(call));

  const mapPath = (root: string, s: string) =>
    s.replace(PATH_RE, (_m, pre, dir) => `${pre}${root}${dir}`);

  const killGroup = (pid: number) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 已退出
    }
  };

  const destroy = async (id: string) => {
    const s = sandboxes.get(id);
    sandboxes.delete(id);
    for (const p of procs.get(id) ?? []) killGroup(p.pid);
    procs.delete(id);
    if (s) await rm(s.root, { recursive: true, force: true });
  };

  const newSandbox = async (body: Record<string, unknown>): Promise<FakeE2BSandbox> => {
    const id = `i${randomBytes(9).toString("hex")}`;
    const root = join(base, id);
    for (const d of ROOT_DIRS) await mkdir(join(root, d), { recursive: true });
    const s: FakeE2BSandbox = {
      id,
      templateID: String(body.templateID),
      metadata: (body.metadata as Record<string, string> | undefined) ?? {},
      state: "running",
      timeout: typeof body.timeout === "number" ? body.timeout : 300,
      autoPause: body.autoPause === true,
      envdAccessToken: randomBytes(12).toString("hex"),
      root,
      ...(typeof body.allow_internet_access === "boolean" && {
        allowInternetAccess: body.allow_internet_access,
      }),
      ...(body.network !== undefined && { network: body.network }),
    };
    sandboxes.set(id, s);
    return s;
  };

  const notFound = (res: ServerResponse, id: string) =>
    sendJson(res, 404, {
      code: 404,
      message: `sandbox "${id}" doesn't exist or you don't have access to it`,
    });

  // ---------- 控制面 API ----------

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown>,
  ) => {
    if (req.headers["x-api-key"] !== apiKey) {
      sendJson(res, 401, {
        code: 401,
        message: "Invalid API key, it must start with 'e2b_' prefix",
      });
      return;
    }
    if (method === "POST" && path === "/v2/sandboxes") {
      if (typeof body.templateID !== "string" || body.templateID === "") {
        sendJson(res, 400, { code: 400, message: "templateID is required" });
        return;
      }
      const s = await newSandbox(body);
      sendJson(res, 201, {
        sandboxID: s.id,
        templateID: s.templateID,
        clientID: "fake",
        envdVersion: "0.4.2",
        envdAccessToken: s.envdAccessToken,
        domain: opts.domain ?? null,
      });
      return;
    }
    if (method === "GET" && path === "/v2/sandboxes") {
      const want = new URLSearchParams(query.metadata ?? "");
      const states = (query.state ?? "running,paused").split(",");
      const all = [...sandboxes.values()].filter((s) => {
        if (!states.includes(s.state)) return false;
        for (const [k, v] of want) {
          if (s.metadata[decodeURIComponent(k)] !== decodeURIComponent(v)) return false;
        }
        return true;
      });
      const limit = Math.min(pageSize, Number(query.limit ?? pageSize) || pageSize);
      const offset = Number(query.nextToken ?? 0) || 0;
      const page = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? String(offset + limit) : undefined;
      sendJson(
        res,
        200,
        page.map((s) => ({
          sandboxID: s.id,
          templateID: s.templateID,
          metadata: s.metadata,
          state: s.state,
          cpuCount: 1,
          memoryMB: 2048,
          envdVersion: "0.4.2",
          startedAt: new Date().toISOString(),
          endAt: new Date().toISOString(),
        })),
        next ? { "x-next-token": next } : {},
      );
      return;
    }
    let m = /^\/v2\/sandboxes\/([^/]+)\/connect$/.exec(path);
    if (m && method === "POST") {
      const s = sandboxes.get(m[1] as string);
      if (!s) return notFound(res, m[1] as string);
      const resumed = s.state === "paused";
      s.state = "running";
      if (body.memory === false) {
        // 冷启动（SDK 的 onResume: "reboot"）：内存里的进程全部结束，文件保留
        for (const p of procs.get(s.id) ?? []) killGroup(p.pid);
        reboots.set(s.id, (reboots.get(s.id) ?? 0) + 1);
      }
      if (typeof body.timeout === "number" && body.timeout > s.timeout) s.timeout = body.timeout;
      sendJson(res, resumed ? 201 : 200, {
        sandboxID: s.id,
        templateID: s.templateID,
        clientID: "fake",
        envdVersion: "0.4.2",
        envdAccessToken: s.envdAccessToken,
        domain: opts.domain ?? null,
      });
      return;
    }
    m = /^\/sandboxes\/([^/]+)\/pause$/.exec(path);
    if (m && method === "POST") {
      const s = sandboxes.get(m[1] as string);
      if (!s) return notFound(res, m[1] as string);
      if (s.state === "paused") {
        sendJson(res, 409, { code: 409, message: "sandbox is already paused" });
        return;
      }
      s.state = "paused";
      sendJson(res, 204);
      return;
    }
    m = /^\/sandboxes\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") {
      if (!sandboxes.has(m[1] as string)) return notFound(res, m[1] as string);
      await destroy(m[1] as string);
      sendJson(res, 204);
      return;
    }
    sendJson(res, 404, { code: 404, message: `no route ${method} ${path}` });
  };

  // ---------- envd ----------

  const userOf = (req: IncomingMessage): string | undefined => {
    const a = req.headers.authorization;
    if (!a?.startsWith("Basic ")) return undefined;
    return Buffer.from(a.slice(6), "base64").toString("utf8").replace(/:.*$/, "");
  };

  const startProcess = (
    s: FakeE2BSandbox,
    msg: {
      process?: { cmd?: string; args?: string[]; envs?: Record<string, string>; cwd?: string };
    },
    res: ServerResponse,
  ) => {
    const p = msg.process ?? {};
    const args = (p.args ?? []).map((a) => mapPath(s.root, a));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    for (const [k, v] of Object.entries(p.envs ?? {})) env[k] = mapPath(s.root, v);
    const cwd = p.cwd ? mapPath(s.root, p.cwd) : join(s.root, "workspace");
    res.writeHead(200, { "content-type": "application/connect+json" });
    let child: ChildProcess;
    try {
      child = spawn(p.cmd ?? "/bin/sh", args, { cwd, env, detached: true, stdio: "pipe" });
    } catch (e) {
      res.end(envelope(2, { error: { code: "internal", message: String(e) } }));
      return;
    }
    child.on("error", (e) => {
      if (!res.writableEnded)
        res.end(envelope(2, { error: { code: "internal", message: e.message } }));
    });
    const pid = child.pid as number;
    if (pid === undefined) return;
    const proc: Proc = { pid, args: [p.cmd ?? "", ...args], child };
    const list = procs.get(s.id) ?? [];
    list.push(proc);
    procs.set(s.id, list);
    child.stdin?.end();
    const write = (msg: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(envelope(0, msg));
    };
    write({ event: { start: { pid } } });
    child.stdout?.on("data", (d: Buffer) =>
      write({ event: { data: { stdout: d.toString("base64") } } }),
    );
    child.stderr?.on("data", (d: Buffer) =>
      write({ event: { data: { stderr: d.toString("base64") } } }),
    );
    child.on("close", (code, signal) => {
      const l = procs.get(s.id);
      if (l)
        procs.set(
          s.id,
          l.filter((x) => x !== proc),
        );
      const end: Record<string, unknown> = signal
        ? { exitCode: -1, status: `signal: ${signal === "SIGKILL" ? "killed" : signal}` }
        : { exited: true, status: `exit status ${code}` };
      if (!signal && code !== 0) end.exitCode = code;
      write({ event: { end } });
      if (!res.writableEnded && !res.destroyed) res.end(envelope(2, {}));
    });
  };

  const handleEnvd = async (
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    path: string,
    query: Record<string, string>,
    raw: Buffer,
    call: FakeE2BCall,
  ) => {
    const s = sandboxes.get(id);
    if (s?.state !== "running") {
      sendJson(res, 502, {
        sandboxId: id,
        message: s ? "The sandbox is paused" : "The sandbox was not found",
        code: 502,
      });
      return;
    }
    if (req.headers["x-access-token"] !== s.envdAccessToken) {
      sendJson(res, 401, { code: 401, message: "invalid access token" });
      return;
    }
    if (path === "/files" && req.method === "POST") {
      call.user = query.username;
      const target = query.path;
      if (!target?.startsWith("/")) {
        sendJson(res, 400, { code: 400, message: "path is required" });
        return;
      }
      const form = await new Response(raw, {
        headers: { "content-type": String(req.headers["content-type"] ?? "") },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        sendJson(res, 400, { code: 400, message: "missing file part" });
        return;
      }
      const host = mapPath(s.root, target);
      if (host === target) {
        sendJson(res, 400, { code: 400, message: "path outside the fake sandbox roots" });
        return;
      }
      await mkdir(dirname(host), { recursive: true });
      await writeFile(host, Buffer.from(await file.arrayBuffer()));
      sendJson(res, 200, [{ path: target, name: target.split("/").pop(), type: "file" }]);
      return;
    }
    if (path === "/process.Process/Start" && req.method === "POST") {
      call.user = userOf(req);
      if (!call.user) {
        sendJson(res, 401, { code: "unauthenticated", message: "missing user" });
        return;
      }
      if (raw.byteLength < 5) {
        sendJson(res, 400, { code: "invalid_argument", message: "missing envelope" });
        return;
      }
      const msg = JSON.parse(raw.subarray(5, 5 + raw.readUInt32BE(1)).toString("utf8"));
      call.body = msg;
      startProcess(s, msg, res);
      return;
    }
    if (path === "/process.Process/SendSignal" && req.method === "POST") {
      const msg = JSON.parse(raw.toString("utf8") || "{}") as {
        process?: { pid?: number };
        signal?: string;
      };
      call.body = msg;
      const pid = msg.process?.pid;
      const p = (procs.get(s.id) ?? []).find((x) => x.pid === pid);
      if (!p) {
        sendJson(res, 404, { code: "not_found", message: `process with pid ${pid} not found` });
        return;
      }
      // 与 envd 一样只给这个进程发信号（不是整个进程组）
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // 已退出
      }
      sendJson(res, 200, {});
      return;
    }
    sendJson(res, 404, { code: "not_found", message: `no route ${req.method} ${path}` });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", "http://fake");
      const method = req.method ?? "GET";
      const query = Object.fromEntries(u.searchParams);
      const raw = await readBody(req);
      const sandboxId = req.headers["e2b-sandbox-id"];
      const isEnvd = typeof sandboxId === "string";
      let body: unknown = null;
      const ct = String(req.headers["content-type"] ?? "");
      if (ct.startsWith("application/json") && raw.byteLength > 0) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          body = null;
        }
      }
      const call: FakeE2BCall = {
        method,
        path: u.pathname,
        query,
        body,
        ...(isEnvd && { sandboxId }),
      };
      if (u.pathname === "/process.Process/Start" && raw.byteLength >= 5) {
        try {
          call.body = JSON.parse(raw.subarray(5, 5 + raw.readUInt32BE(1)).toString("utf8"));
        } catch {
          call.body = null;
        }
      }
      calls.push(call);
      const fi = fails.findIndex((f) => matches(f.match, call));
      if (fi >= 0) {
        const [f] = fails.splice(fi, 1);
        if (f?.raw) res.writeHead(f.status, { "content-type": "text/plain" }).end(f.message);
        else if (f) sendJson(res, f.status, { code: f.status, message: f.message });
        return;
      }
      const hi = hangs.findIndex((h) => matches(h, call));
      if (hi >= 0) {
        hangs.splice(hi, 1);
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        return;
      }
      if (isEnvd) {
        await handleEnvd(req, res, sandboxId, u.pathname, query, raw, call);
      } else {
        await handleApi(
          req,
          res,
          method,
          u.pathname,
          query,
          (body ?? {}) as Record<string, unknown>,
        );
      }
    })().catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { code: 500, message: String(e) });
      else res.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    apiKey,
    sandboxes,
    calls,
    failNext(match, status, message = `fake failure ${status}`, opts = {}) {
      fails.push({ match, status, message, raw: opts.raw === true });
    },
    reboots,
    hangNext(match) {
      hangs.push(match);
    },
    expire: destroy,
    hostPath(id, sandboxPath) {
      const s = sandboxes.get(id);
      if (!s) throw new Error(`no fake sandbox ${id}`);
      return mapPath(s.root, sandboxPath);
    },
    running(id) {
      return (procs.get(id) ?? []).map((p) => ({ pid: p.pid, args: p.args }));
    },
    alive(pid) {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      for (const id of [...sandboxes.keys()]) await destroy(id);
      for (const r of hanging) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(base, { recursive: true, force: true });
    },
  };
}
