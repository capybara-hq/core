/** 解析出的一条 SSE 消息；`comment` 为 `:` 开头的注释行（心跳）。 */
export interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** 用 fetch 读 SSE 流：逐块解析消息，`until` 等到满足条件的消息。 */
export interface SseClient {
  status: number;
  headers: Headers;
  messages: SseMessage[];
  until(pred: (msgs: SseMessage[]) => boolean, timeoutMs?: number, label?: string): Promise<void>;
  close(): void;
}

/** 打开一条 SSE 连接（真实端口；非 200 时也返回，`messages` 为空）。 */
export async function openSse(url: string, headers: Record<string, string>): Promise<SseClient> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const messages: SseMessage[] = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  let ended = false;
  void (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m: SseMessage = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) m.comment = line.slice(1).trim();
            else {
              const c = line.indexOf(":");
              const key = line.slice(0, c);
              const v = line.slice(c + 1).replace(/^ /, "");
              if (key === "id" || key === "event") m[key] = v;
              else if (key === "data") m.data = m.data === undefined ? v : `${m.data}\n${v}`;
            }
          }
          messages.push(m);
        }
        notify();
      }
    } catch {
      // 客户端主动中止
    } finally {
      ended = true;
      notify();
    }
  })();
  return {
    status: res.status,
    headers: res.headers,
    messages,
    until(pred, timeoutMs = 10_000, label = "sse condition") {
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (pred(messages)) {
            cleanup();
            resolve();
          } else if (ended) {
            cleanup();
            reject(new Error(`stream ended before ${label}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    close: () => ac.abort(),
  };
}

/** 流里 `event: ui` 帧的数据。 */
export const uiFrames = (msgs: SseMessage[]): { plugin: string; contribution: string }[] =>
  msgs.filter((m) => m.event === "ui").map((m) => JSON.parse(m.data as string));
