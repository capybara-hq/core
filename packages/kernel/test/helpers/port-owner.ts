import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 在 `pids` 里找出本机上以 `port` 为本地 TCP 端口的进程（即这条连接的客户端一侧）。双副本测试用它把假平台记下的
 * 长连接对端端口（`socketPeerPorts()`）对应到副本进程：真实插件连假平台时不带 pid 之类的标记。
 *
 * Linux 先读 `/proc/net/tcp{,6}` 找端口对应的 socket inode，再在各进程的 `/proc/<pid>/fd` 里找这个 inode；
 * 找不到时依次退回 `ss -tnp`、`lsof`。其他平台（macOS）用 `lsof`。都找不到返回 undefined。
 */
export async function pidOwningLocalPort(
  port: number,
  pids: readonly number[],
): Promise<number | undefined> {
  if (process.platform === "linux") {
    return (await viaProc(port, pids)) ?? (await viaSs(port, pids)) ?? (await viaLsof(port, pids));
  }
  return viaLsof(port, pids);
}

async function viaProc(port: number, pids: readonly number[]): Promise<number | undefined> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const inode = cols[9];
      if (local?.endsWith(`:${hexPort}`) && inode !== undefined && inode !== "0") inodes.add(inode);
    }
  }
  if (inodes.size === 0) return undefined;
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m?.[1] !== undefined && inodes.has(m[1])) return pid;
    }
  }
  return undefined;
}

async function viaSs(port: number, pids: readonly number[]): Promise<number | undefined> {
  // 行形如 `ESTAB 0 0 127.0.0.1:54321 127.0.0.1:8080 users:(("node",pid=1234,fd=20))`；第 4 列是本地地址
  const out = await run("ss", ["-tnpH", "state", "established"]).then(
    (r) => r.stdout,
    () => "",
  );
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c, i) => i < 5 && /:\d+$/.test(c));
    if (!local?.endsWith(`:${port}`)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (pids.includes(pid)) return pid;
    }
  }
  return undefined;
}

async function viaLsof(port: number, pids: readonly number[]): Promise<number | undefined> {
  // -a：各条件取交集；-iTCP:<port> 匹配本地或对端端口，而对端是假平台（本测试进程，不在 pids 里）
  const args = ["-nP", "-a", "-p", pids.join(","), `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"];
  const out = await run("lsof", args).then(
    (r) => r.stdout,
    // 没有匹配时 lsof 以 1 退出
    (e: { stdout?: string }) => e.stdout ?? "",
  );
  for (const line of out.split("\n")) {
    if (!line.startsWith("p")) continue;
    const pid = Number(line.slice(1));
    if (pids.includes(pid)) return pid;
  }
  return undefined;
}
