import { describe, expect, it } from "vitest";
import {
  GITHUB_DEVICE_LOGIN_URL,
  parseDeviceCode,
} from "../../../src/tools/builtins/sandbox/device-code.js";
import { READ_TAIL_BYTES, readWindow } from "../../../src/tools/builtins/sandbox/task-output.js";

/**
 * `TaskOutput`'s bounded read window (review follow-up N1): a read also re-reads up to
 * {@link READ_TAIL_BYTES} of already-delivered output, so a prompt split across reads still matches
 * and the buffer never grows with the task's output.
 */

/** Recorded `gh auth login --web` prompt: the code line first, then the URL line (real order). */
const CODE_LINE = "! First copy your one-time code: 1A2B-C3D4";
const URL_LINE = "- Press Enter to open https://github.com/login/device in your browser...";
const PROMPT = `${CODE_LINE}\n${URL_LINE}\n`;

/**
 * One read exactly as `taskOutputTool` makes it: the window, the bytes it returns, the already
 * delivered part to skip, and the offset the next read starts from (the fixture is ASCII, so no
 * character is cut).
 */
function readOnce(
  bytes: Buffer,
  offset: number,
  cap: number,
): { parsed: string; fresh: string; next: number } {
  const window = readWindow(offset, cap);
  const data = bytes.subarray(window.offset, window.offset + window.cap);
  const fresh = data.subarray(window.skip);
  return {
    parsed: data.toString("utf8"),
    fresh: fresh.toString("utf8"),
    // the fixture is ASCII: fresh's byte length is the offset advance
    next: offset + fresh.length,
  };
}

describe("TaskOutput read window: a prompt split across reads", () => {
  it("read 1 ends mid-prompt and read 2 carries the rest: the tail makes the code match", () => {
    const bytes = Buffer.from(PROMPT, "utf8");
    const cap = 50;
    const first = readOnce(bytes, 0, cap);
    // the first read ends after the code line, before the URL line: no complete prompt yet
    expect(first.parsed).toContain(CODE_LINE);
    expect(first.parsed).not.toContain(GITHUB_DEVICE_LOGIN_URL);
    expect(parseDeviceCode(first.parsed)).toBeNull();
    expect(first.next).toBe(cap);

    const second = readOnce(bytes, first.next, cap);
    // the new bytes alone hold only the URL line; the re-read tail holds the code line, so the
    // parser sees both
    expect(second.fresh).toContain(GITHUB_DEVICE_LOGIN_URL);
    expect(second.fresh).not.toContain(CODE_LINE);
    expect(parseDeviceCode(second.fresh)).toBeNull();
    expect(parseDeviceCode(second.parsed)).toEqual({
      url: GITHUB_DEVICE_LOGIN_URL,
      code: "1A2B-C3D4",
    });
  });

  it("the code line and the URL line in separate reads match (gh emits the code first)", () => {
    // `gh auth login --web` prints the code line before the URL line (recorded, gh 2.63); no other
    // order exists to test.
    const lineSplit = `${CODE_LINE}\n`;
    const first = readOnce(Buffer.from(PROMPT, "utf8"), 0, Buffer.byteLength(lineSplit));
    expect(parseDeviceCode(first.parsed)).toBeNull();
    const second = readOnce(Buffer.from(PROMPT, "utf8"), first.next, 100);
    expect(parseDeviceCode(second.parsed)?.code).toBe("1A2B-C3D4");
  });

  it("a cap that splits inside a line still matches a later read", () => {
    const bytes = Buffer.from(PROMPT, "utf8");
    let offset = 0;
    const seen: Array<string | null> = [];
    // a cap of 30 bytes reaches the whole prompt only through the re-read tail
    for (let i = 0; i < 10 && offset < bytes.length; i++) {
      const r = readOnce(bytes, offset, 30);
      seen.push(parseDeviceCode(r.parsed)?.code ?? null);
      offset = r.next;
    }
    expect(seen.filter((code) => code === null).length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe("1A2B-C3D4");
  });

  it("two normal reads deliver all output once and the parser still sees the prompt", () => {
    const bytes = Buffer.from(PROMPT, "utf8");
    const first = readOnce(bytes, 0, 50_000);
    expect(parseDeviceCode(first.parsed)?.code).toBe("1A2B-C3D4");
    expect(first.fresh).toBe(PROMPT);
    expect(first.next).toBe(bytes.length);
    // nothing new is delivered, but the bounded tail still carries the prompt (the pipeline dedupes
    // the event by code)
    const second = readOnce(bytes, first.next, 50_000);
    expect(second.fresh).toBe("");
    expect(second.next).toBe(bytes.length);
    expect(parseDeviceCode(second.parsed)?.code).toBe("1A2B-C3D4");
  });
});

describe("TaskOutput read window: bounded", () => {
  it("stays cap + READ_TAIL_BYTES whatever the output size or offset", () => {
    const cap = 50_000;
    for (const offset of [0, 1, READ_TAIL_BYTES - 1, READ_TAIL_BYTES, 1_000_000, 10_000_000]) {
      const window = readWindow(offset, cap);
      expect(window.cap).toBeLessThanOrEqual(cap + READ_TAIL_BYTES);
      expect(window.skip).toBeLessThanOrEqual(READ_TAIL_BYTES);
      expect(window.offset + window.skip).toBe(offset);
      expect(window.offset).toBe(Math.max(0, offset - READ_TAIL_BYTES));
    }
  });

  it("a bogus huge line never grows the buffer and never matches", () => {
    // one 200 KiB line with no newline, in windows of 50 KiB
    const bytes = Buffer.from("x".repeat(200_000), "utf8");
    let offset = 0;
    for (let i = 0; i < 6 && offset < bytes.length; i++) {
      const r = readOnce(bytes, offset, 50_000);
      expect(Buffer.byteLength(r.parsed)).toBeLessThanOrEqual(50_000 + READ_TAIL_BYTES);
      expect(parseDeviceCode(r.parsed)).toBeNull();
      offset = r.next;
    }
    expect(offset).toBe(bytes.length);
  });
});
