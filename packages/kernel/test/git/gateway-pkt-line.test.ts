import { describe, expect, it } from "vitest";
import {
  advertisementError,
  FLUSH_PKT,
  pktLine,
  ReceivePackParseError,
  readReceivePackCommands,
  receivePackRefusal,
} from "../../src/git/pkt-line.js";

/**
 * The pkt-line pieces of the git gateway (sandbox git credentials spec §5.3, §7): reading the ref
 * updates at the start of a receive-pack body and the refusals git prints.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

/** An async iterator over `chunks`, recording how many were pulled. */
function chunksOf(chunks: Buffer[]): AsyncIterator<Buffer> & { pulled: number } {
  let i = 0;
  const it = {
    pulled: 0,
    next: async () => {
      it.pulled++;
      const value = chunks[i++];
      return value === undefined
        ? { done: true as const, value: undefined }
        : { done: false as const, value };
    },
  };
  return it;
}

/** Splits `buf` into chunks of `size` bytes. */
const split = (buf: Buffer, size: number): Buffer[] => {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
};

describe("readReceivePackCommands", () => {
  it("reads commands and capabilities across chunk boundaries and stops at the flush-pkt", async () => {
    const body = Buffer.concat([
      pktLine(`shallow ${B}\n`),
      pktLine(`${Z} ${A} refs/heads/feat\0 report-status side-band-64k agent=git/2\n`),
      pktLine(`${A} ${B} refs/heads/main\n`),
      FLUSH_PKT,
      Buffer.from("PACK...."),
    ]);
    const chunks = split(body, 7);
    const it = chunksOf([...chunks, Buffer.from("never read")]);
    const r = await readReceivePackCommands(it);
    expect(r.commands).toEqual([
      { oldId: Z, newId: A, ref: "refs/heads/feat" },
      { oldId: A, newId: B, ref: "refs/heads/main" },
    ]);
    expect(r.capabilities).toEqual(["report-status", "side-band-64k", "agent=git/2"]);
    // every byte read is kept for the upstream, and nothing after the flush's chunk is pulled
    expect(body.subarray(0, r.prefix.length).equals(r.prefix)).toBe(true);
    expect(it.pulled).toBeLessThan(chunks.length + 1);
  });

  it("accepts a bare flush-pkt (git's probe) as no commands", async () => {
    const r = await readReceivePackCommands(chunksOf([FLUSH_PKT]));
    expect(r.commands).toEqual([]);
  });

  it("refuses signed pushes, malformed lines and bodies that end early", async () => {
    for (const body of [
      Buffer.concat([pktLine(`push-cert\0 report-status\n`), FLUSH_PKT]),
      Buffer.concat([pktLine(`${Z} ${A}\n`), FLUSH_PKT]),
      Buffer.concat([pktLine(`${Z} ${A} HEAD\n`), FLUSH_PKT]),
      Buffer.concat([pktLine(`zz ${A} refs/heads/x\n`), FLUSH_PKT]),
      Buffer.from("zzzz"),
      Buffer.from("0002"),
      pktLine(`${Z} ${A} refs/heads/x\n`),
    ]) {
      await expect(readReceivePackCommands(chunksOf([body]))).rejects.toBeInstanceOf(
        ReceivePackParseError,
      );
    }
  });
});

describe("refusals", () => {
  it("an advertisement starts with an ERR pkt-line", () => {
    expect(advertisementError("Capybara: no\nmore").toString()).toBe("001aERR Capybara: no more\n");
  });

  it("a receive-pack refusal follows the client's capabilities", () => {
    const sb = receivePackRefusal(
      ["report-status", "side-band-64k"],
      ["refs/heads/main"],
      "msg",
      "why",
    );
    // band 2 message, band 1 report (unpack ok + ng), flush
    expect(sb.subarray(4, 5)[0]).toBe(2);
    expect(sb.toString("latin1")).toContain("ng refs/heads/main why\n");
    expect(sb.subarray(-4).toString()).toBe("0000");

    const plain = receivePackRefusal(["report-status"], ["refs/heads/main"], "msg", "why");
    expect(plain.toString()).toBe(
      `${pktLine("unpack ok\n").toString()}${pktLine("ng refs/heads/main why\n").toString()}0000`,
    );
    expect(receivePackRefusal([], ["refs/heads/main"], "msg", "why").toString()).toBe(
      pktLine("ERR msg\n").toString(),
    );
  });
});
