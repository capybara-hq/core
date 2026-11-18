import { describe, expect, it } from "vitest";
import {
  assembleOutputSuffix,
  assembleTaskOutput,
  FRESH_WINDOW_MAX_BYTES,
  lastLinesOf,
  ManagedOutputCapacityError,
  ManagedOutputUnavailableError,
  OUTPUT_HISTORY_BYTES,
  type OutputReader,
} from "../../src/background/managed-output.js";
import {
  GITHUB_DEVICE_LOGIN_URL,
  parseDeviceCode,
} from "../../src/tools/builtins/sandbox/device-code.js";

/**
 * Bounded assembly of a managed task's retained output (permission runtime cutover phase 8.3,
 * design §B5): adjacent capacity-bounded reads, a 4,096-byte parser history, whole-character
 * progress on a live stream, replacement decoding only at a verified terminal end, and an HTTP
 * suffix whose end is the probed total even when the output grows.
 */

const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/**
 * A retained append-only output, read as the kernel adapter answers it: each read is clamped to
 * the transport capacity (which may change between reads, like a stale saved client limit
 * replaced by a renegotiated one) and returns exactly min(budget, total - offset) bytes.
 */
function retained(initial: Uint8Array, capacity: number | (() => number)) {
  let buf = initial;
  const requests: { offset: number; maxBytes: number; returned: number }[] = [];
  let beforeRead: ((n: number) => void) | undefined;
  const read: OutputReader = async (offset, maxBytes) => {
    beforeRead?.(requests.length);
    const c = typeof capacity === "function" ? capacity() : capacity;
    const n = Math.max(0, Math.min(maxBytes, c, buf.length - offset));
    const data = buf.slice(offset, offset + n);
    requests.push({ offset, maxBytes, returned: data.length });
    return { data, offset, nextOffset: offset + data.length, totalBytes: buf.length };
  };
  return {
    read,
    requests,
    append(more: Uint8Array) {
      buf = cat(buf, more);
    },
    onRead(fn: (n: number) => void) {
      beforeRead = fn;
    },
  };
}

/** Mixed 1-, 2-, 3- and 4-byte characters. */
function mixedText(chars: number): string {
  const alphabet = ["a", "é", "€", "😀", "\n"];
  let s = "";
  for (let i = 0; i < chars; i++) s += alphabet[i % alphabet.length];
  return s;
}

/** Every data read starts where the previous one in its range ended: no overlap, no re-reads. */
function expectAdjacent(requests: { offset: number; maxBytes: number; returned: number }[]) {
  const data = requests.filter((r) => r.maxBytes > 0);
  const seen = new Set<number>();
  for (const r of data) {
    expect(seen.has(r.offset)).toBe(false);
    seen.add(r.offset);
    expect(r.maxBytes).toBeLessThanOrEqual(65_536);
  }
}

describe("TaskOutput assembly over bounded reads", () => {
  for (const capacity of [1, 2, 3, 3072, 4095, 4096, 4097, 65_536]) {
    it(`capacity ${capacity}: history window, whole characters and an exact byte cursor`, async () => {
      const text = mixedText(4000);
      const bytes = enc(text);
      // a cursor on a character boundary somewhere past the history window
      const cursor = enc(text.slice(0, 2600)).length;
      const s = retained(bytes, capacity);
      const r = await assembleTaskOutput(s.read, { offset: cursor, budget: 3000, terminal: false });
      expect(r.snapshot).toBe(bytes.length);
      expect(r.history.length).toBe(OUTPUT_HISTORY_BYTES);
      expect(Buffer.from(r.history).equals(Buffer.from(bytes.slice(cursor - 4096, cursor)))).toBe(
        true,
      );
      // whole characters only, ending at most at the budget
      expect(r.delivered.length).toBeGreaterThan(2996);
      expect(r.delivered.length).toBeLessThanOrEqual(3000 + 3);
      expect(Buffer.from(r.delivered).toString("utf8")).not.toContain("�");
      expect(r.text).toBe(Buffer.from(bytes.slice(cursor, r.nextOffset)).toString("utf8"));
      expect(r.nextOffset).toBe(cursor + r.delivered.length);
      expect(r.remaining).toBe(bytes.length - r.nextOffset);
      expectAdjacent(s.requests);
      // the metadata probe comes first and asks for nothing
      expect(s.requests[0]).toMatchObject({ maxBytes: 0 });
    });
  }

  for (const capacity of [1, 2, 3]) {
    it(`capacity ${capacity}: completes a four-byte character cut by the window`, async () => {
      const bytes = enc("abc😀def");
      const s = retained(bytes, capacity);
      // the four-byte window ends inside the emoji: the adjacent bytes complete it
      const r = await assembleTaskOutput(s.read, { offset: 0, budget: 4, terminal: false });
      expect(r.text).toBe("abc😀");
      expect(r.nextOffset).toBe(7);
      expect(r.remaining).toBe(3);
      expectAdjacent(s.requests);
    });
  }

  it("withholds an incomplete live suffix without advancing, then delivers it once complete", async () => {
    const emoji = enc("😀");
    const s = retained(cat(enc("ok"), emoji.slice(0, 2)), 2);
    const first = await assembleTaskOutput(s.read, { offset: 0, budget: 100, terminal: false });
    expect(first.text).toBe("ok");
    expect(first.nextOffset).toBe(2);
    expect(first.withheld).toBe(true);
    // the same unchanged end: a truthful no-progress answer, not a spin
    const before = s.requests.length;
    const again = await assembleTaskOutput(s.read, { offset: 2, budget: 100, terminal: false });
    expect(again.text).toBe("");
    expect(again.nextOffset).toBe(2);
    expect(s.requests.length - before).toBeLessThanOrEqual(4);
    s.append(emoji.slice(2));
    const done = await assembleTaskOutput(s.read, { offset: 2, budget: 100, terminal: false });
    expect(done.text).toBe("😀");
    expect(done.nextOffset).toBe(6);
  });

  it("at a verified terminal end consumes incomplete bytes with replacement decoding by raw count", async () => {
    const s = retained(cat(enc("ok"), new Uint8Array([0xf0, 0x9f])), 1);
    const r = await assembleTaskOutput(s.read, { offset: 0, budget: 100, terminal: true });
    expect(r.text.startsWith("ok")).toBe(true);
    expect(r.text).toContain("�");
    // the cursor moves by the four raw bytes, never by the replacement's encoded length
    expect(r.nextOffset).toBe(4);
    expect(r.remaining).toBe(0);
  });

  it("the terminal rule also holds when the window exactly equals its budget", async () => {
    const s = retained(cat(enc("ab"), new Uint8Array([0xe2, 0x82])), 4096);
    const r = await assembleTaskOutput(s.read, { offset: 0, budget: 4, terminal: true });
    expect(r.nextOffset).toBe(4);
    expect(r.text).toContain("�");
  });

  it("delivers invalid bytes inside a live window with replacement, never stalling on them", async () => {
    const s = retained(new Uint8Array([0x61, 0xff, 0x62, 0x0a]), 4096);
    const r = await assembleTaskOutput(s.read, { offset: 0, budget: 100, terminal: false });
    expect(r.text).toBe("a�b\n");
    expect(r.nextOffset).toBe(4);
  });

  it("a renegotiated lower capacity mid-assembly still assembles every byte adjacently", async () => {
    const bytes = enc(mixedText(3000));
    let reads = 0;
    const s = retained(bytes, () => (reads++ < 3 ? 4096 : 1000));
    const r = await assembleTaskOutput(s.read, { offset: 0, budget: 6000, terminal: true });
    expect(r.text).toBe(Buffer.from(bytes.slice(0, r.nextOffset)).toString("utf8"));
    // the window ends inside a character: its adjacent bytes complete it
    expect(r.nextOffset).toBeGreaterThanOrEqual(6000);
    expect(r.nextOffset).toBeLessThanOrEqual(6003);
    expectAdjacent(s.requests);
  });

  it("zero capacity with unread bytes is a deterministic capacity error, never EOF", async () => {
    const s = retained(enc("hello"), 0);
    await expect(
      assembleTaskOutput(s.read, { offset: 0, budget: 100, terminal: true }),
    ).rejects.toBeInstanceOf(ManagedOutputCapacityError);
    // with nothing unread the probe alone answers
    const empty = retained(new Uint8Array(), 0);
    const r = await assembleTaskOutput(empty.read, { offset: 0, budget: 100, terminal: false });
    expect(r).toMatchObject({ text: "", nextOffset: 0, remaining: 0 });
  });

  it("a cursor past the snapshot, a regressing total or an expired record is unavailable", async () => {
    const s = retained(enc("abc"), 10);
    await expect(
      assembleTaskOutput(s.read, { offset: 9, budget: 10, terminal: false }),
    ).rejects.toMatchObject({ reason: "mismatch" });
    let total = 100;
    const shrinking: OutputReader = async (offset, maxBytes) => {
      const t = total;
      total = 1;
      const n = Math.max(0, Math.min(maxBytes, t - offset));
      return { data: new Uint8Array(n), offset, nextOffset: offset + n, totalBytes: t };
    };
    await expect(
      assembleTaskOutput(shrinking, { offset: 0, budget: 10, terminal: false }),
    ).rejects.toMatchObject({ reason: "lost" });
    const expired: OutputReader = async () => ({ unavailable: "expired" });
    await expect(
      assembleTaskOutput(expired, { offset: 0, budget: 10, terminal: false }),
    ).rejects.toBeInstanceOf(ManagedOutputUnavailableError);
  });

  it("a malformed answer (wrong offset or overlong data) is rejected", async () => {
    const wrongOffset: OutputReader = async (offset, maxBytes) => ({
      data: new Uint8Array(Math.min(maxBytes, 3)),
      offset: offset + 1,
      nextOffset: offset + 1 + Math.min(maxBytes, 3),
      totalBytes: 10,
    });
    await expect(
      assembleTaskOutput(wrongOffset, { offset: 0, budget: 10, terminal: false }),
    ).rejects.toThrow();
    const overlong: OutputReader = async (offset, maxBytes) => ({
      data: new Uint8Array(maxBytes + 1),
      offset,
      nextOffset: offset + maxBytes + 1,
      totalBytes: 1000,
    });
    await expect(
      assembleTaskOutput(overlong, { offset: 0, budget: 10, terminal: false }),
    ).rejects.toThrow();
  });

  it("growth after the probe stays out of this answer and is counted from the snapshot", async () => {
    const s = retained(enc("0123456789"), 3);
    s.onRead((n) => {
      if (n === 1) s.append(enc("ABCDEFGHIJ"));
    });
    const r = await assembleTaskOutput(s.read, { offset: 0, budget: 100, terminal: false });
    expect(r.snapshot).toBe(10);
    expect(r.text).toBe("0123456789");
    expect(r.remaining).toBe(0);
    const next = await assembleTaskOutput(s.read, {
      offset: r.nextOffset,
      budget: 100,
      terminal: false,
    });
    expect(next.text).toBe("ABCDEFGHIJ");
  });

  it("a budget above one window is assembled window by window with bounded reads", async () => {
    const bytes = enc("x".repeat(150_000));
    const s = retained(bytes, 65_536);
    const r = await assembleTaskOutput(s.read, { offset: 0, budget: 100_000, terminal: false });
    expect(r.nextOffset).toBe(100_000);
    expect(r.remaining).toBe(50_000);
    for (const q of s.requests) expect(q.maxBytes).toBeLessThanOrEqual(FRESH_WINDOW_MAX_BYTES);
    expectAdjacent(s.requests);
  });

  it("repeated identical bytes are delivered by position, never deduplicated", async () => {
    const line = enc("same line\n");
    const s = retained(cat(line, line, line), 7);
    const first = await assembleTaskOutput(s.read, { offset: 0, budget: 10, terminal: false });
    expect(first.text).toBe("same line\n");
    const second = await assembleTaskOutput(s.read, {
      offset: first.nextOffset,
      budget: 100,
      terminal: false,
    });
    expect(second.text).toBe("same line\nsame line\n");
    expect(second.nextOffset).toBe(30);
  });

  it("the parser sees the history plus the new bytes, so a split login prompt matches", async () => {
    const code = "! First copy your one-time code: 1A2B-C3D4\n";
    const url = `- Press Enter to open ${GITHUB_DEVICE_LOGIN_URL} in your browser...\n`;
    const s = retained(enc(code + url), 5);
    const first = await assembleTaskOutput(s.read, {
      offset: 0,
      budget: code.length,
      terminal: false,
    });
    expect(parseDeviceCode(first.parserText)).toBeNull();
    const second = await assembleTaskOutput(s.read, {
      offset: first.nextOffset,
      budget: 1000,
      terminal: false,
    });
    expect(parseDeviceCode(second.text)).toBeNull();
    expect(parseDeviceCode(second.parserText)).toEqual({
      url: GITHUB_DEVICE_LOGIN_URL,
      code: "1A2B-C3D4",
    });
  });
});

describe("HTTP suffix assembly", () => {
  it("assembles the suffix ending exactly at the probed total while the output grows", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"é".repeat(i % 7)}`).join(
      "\n",
    );
    const bytes = enc(lines);
    const s = retained(bytes, 1000);
    s.onRead((n) => {
      if (n >= 1) s.append(enc("\nGROWN AFTER THE PROBE"));
    });
    const r = await assembleOutputSuffix(s.read, 3000);
    expect(r.end).toBe(bytes.length);
    expect(r.truncated).toBe(true);
    const expected = Buffer.from(bytes.slice(bytes.length - 3000)).toString("utf8");
    // only a leading partial character is dropped; every line of the suffix is kept
    expect(expected.endsWith(r.text)).toBe(true);
    expect(expected.length - r.text.length).toBeLessThanOrEqual(1);
    expect(r.text).not.toContain("GROWN");
    expect(r.text.split("\n").length).toBeGreaterThan(20);
    expectAdjacent(s.requests);
  });

  it("a whole output within the budget is not truncated; zero bytes needs no data read", async () => {
    const s = retained(enc("short\n"), 2);
    expect(await assembleOutputSuffix(s.read, 1000)).toEqual({
      text: "short\n",
      truncated: false,
      end: 6,
    });
    const empty = retained(new Uint8Array(), 0);
    expect(await assembleOutputSuffix(empty.read, 1000)).toEqual({
      text: "",
      truncated: false,
      end: 0,
    });
    expect(empty.requests.every((q) => q.maxBytes === 0)).toBe(true);
  });

  it("zero capacity with a needed range is a capacity error", async () => {
    const s = retained(enc("data"), 0);
    await expect(assembleOutputSuffix(s.read, 10)).rejects.toBeInstanceOf(
      ManagedOutputCapacityError,
    );
  });
});

describe("terminal summaries", () => {
  it("keeps the last 20 lines and at most 4,000 characters", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const last = lastLinesOf(enc(`${lines}\n`));
    expect(last.split("\n").filter((l) => l !== "")).toEqual(
      Array.from({ length: 20 }, (_, i) => `l${i + 10}`),
    );
    expect(lastLinesOf(enc("y".repeat(9000))).length).toBe(4000);
  });
});
