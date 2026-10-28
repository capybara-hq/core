/** Loki output of the kernel logger (`log.loki.*`). */
export interface LokiOptions {
  /** Loki base URL (`http://loki:3100`) or the full push URL (`…/loki/api/v1/push`). */
  url: string;
  username?: string;
  password?: string;
  /** Extra stream labels; `role` and `level` are always the record's own. */
  labels: Record<string, string>;
  /** The `role` label: the process's roles joined by `,`. */
  role: string;
  /** Push interval in ms; default 2000. */
  intervalMs?: number;
  /** Records kept while Loki is slow or down; the oldest are dropped beyond it. Default 10000. */
  maxBuffer?: number;
  /** Where push failures are reported (at most once per minute); default stderr. */
  onError?: (message: string) => void;
  /** Clock for the error rate limit (tests). */
  now?: () => number;
}

/** A pino destination that batches records and pushes them to Loki. */
export interface LokiStream {
  write(line: string): void;
  /** Pushes everything buffered (waits for a push in flight first). Never rejects. */
  flush(): Promise<void>;
  /** Flushes and stops the interval. */
  close(): Promise<void>;
}

const PUSH_PATH = "/loki/api/v1/push";
const PUSH_TIMEOUT_MS = 10_000;
/** A batch is pushed right away once it reaches this many records. */
const BATCH_SIZE = 1_000;
const ERROR_NOTE_INTERVAL_MS = 60_000;

interface Entry {
  level: string;
  ns: string;
  line: string;
}

function pushUrl(url: string): URL {
  const u = new URL(url);
  if (!u.pathname.endsWith(PUSH_PATH)) u.pathname = `${u.pathname.replace(/\/+$/, "")}${PUSH_PATH}`;
  return u;
}

/**
 * Batches JSON log lines and POSTs them to Loki's push API (JSON body), one stream per level with
 * the labels `{ job: "capybara", ...labels, role, level }`. Pushing never blocks or throws into the
 * caller: a failed push drops its batch and is reported to `onError` at most once per minute; while
 * Loki is down at most `maxBuffer` records are kept. The interval timer is unref'd.
 */
export function createLokiStream(opts: LokiOptions): LokiStream {
  const url = pushUrl(opts.url);
  const intervalMs = opts.intervalMs ?? 2_000;
  const maxBuffer = opts.maxBuffer ?? 10_000;
  const now = opts.now ?? Date.now;
  const onError = opts.onError ?? ((m: string) => void process.stderr.write(`capybara: ${m}\n`));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.username !== undefined || opts.password !== undefined) {
    const token = Buffer.from(`${opts.username ?? ""}:${opts.password ?? ""}`).toString("base64");
    headers.authorization = `Basic ${token}`;
  }
  const baseLabels = { job: "capybara", ...opts.labels, role: opts.role };

  let buffer: Entry[] = [];
  let dropped = 0;
  let inFlight: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lastNote = Number.NEGATIVE_INFINITY;
  let closed = false;

  const note = (reason: string) => {
    const t = now();
    if (t - lastNote < ERROR_NOTE_INTERVAL_MS) return;
    lastNote = t;
    // origin only: a URL may carry credentials
    onError(
      `cannot push logs to Loki at ${url.origin} (${reason}); records are dropped until it ` +
        "recovers, further errors are not reported for a minute",
    );
  };

  const pushBatch = async (batch: Entry[], lost: number): Promise<void> => {
    const streams = new Map<string, Array<[string, string]>>();
    for (const e of batch) {
      const values = streams.get(e.level) ?? [];
      values.push([e.ns, e.line]);
      streams.set(e.level, values);
    }
    const body = JSON.stringify({
      streams: [...streams].map(([level, values]) => ({
        stream: { ...baseLabels, level },
        values,
      })),
    });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (!res.ok) note(`HTTP ${res.status}`);
      else if (lost > 0) note(`${lost} records were dropped while the buffer was full`);
    } catch (e) {
      note(e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : "error");
    }
  };

  /** Starts a push of the current buffer unless one is in flight. */
  const kick = (): Promise<void> => {
    if (inFlight || buffer.length === 0) return inFlight ?? Promise.resolve();
    const batch = buffer;
    const lost = dropped;
    buffer = [];
    dropped = 0;
    inFlight = pushBatch(batch, lost).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const ensureTimer = () => {
    if (timer || closed) return;
    timer = setInterval(() => void kick(), intervalMs);
    timer.unref();
  };

  return {
    write(chunk) {
      for (const line of chunk.split("\n")) {
        if (line === "") continue;
        let level = "info";
        let ms = Date.now();
        try {
          const rec = JSON.parse(line) as { level?: unknown; time?: unknown };
          if (typeof rec.level === "string") level = rec.level;
          if (typeof rec.time === "string") {
            const t = Date.parse(rec.time);
            if (!Number.isNaN(t)) ms = t;
          }
        } catch {
          // not JSON: push it as is
        }
        buffer.push({ level, ns: `${BigInt(ms) * 1_000_000n}`, line });
        if (buffer.length > maxBuffer) {
          buffer.shift();
          dropped++;
        }
      }
      ensureTimer();
      if (buffer.length >= BATCH_SIZE) void kick();
    },
    async flush() {
      while (inFlight || buffer.length > 0) {
        if (inFlight) await inFlight;
        else await kick();
      }
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await this.flush();
    },
  };
}
