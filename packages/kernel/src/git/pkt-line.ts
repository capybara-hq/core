/**
 * Git pkt-lines (gitprotocol-common: a 4-hex-digit length that counts itself, then the payload;
 * `0000` is the flush-pkt) as far as the git gateway needs them: the ref update commands at the
 * start of a `git-receive-pack` request body, and the refusals git prints to the person running
 * the command (sandbox git credentials spec §5.3).
 */

/** The flush-pkt. */
export const FLUSH_PKT = Buffer.from("0000", "latin1");

/** The largest pkt-line (header included). */
const MAX_PKT = 65520;

/** One pkt-line holding `data` (a longer payload is clipped to fit). */
export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const clipped = body.subarray(0, MAX_PKT - 4);
  return Buffer.concat([
    Buffer.from((clipped.length + 4).toString(16).padStart(4, "0"), "latin1"),
    clipped,
  ]);
}

/** One ref update of a push: `<old> <new> <ref>`. */
export interface RefCommand {
  oldId: string;
  newId: string;
  ref: string;
}

/** The command list at the start of a receive-pack request. */
export interface ReceivePackCommands {
  commands: RefCommand[];
  /** The capabilities the client asked for (after the NUL of the first command). */
  capabilities: string[];
  /** Every byte read from the body so far (the commands and whatever followed in the chunk). */
  prefix: Buffer;
}

/** Why the command list could not be read: the body is not a push the gateway can decide. */
export class ReceivePackParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivePackParseError";
  }
}

/** Bounds of the command list the gateway reads before it decides. */
export const MAX_COMMANDS = 1000;
export const MAX_COMMAND_BYTES = 1024 * 1024;

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHALLOW = /^shallow [0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Reads the ref update commands at the start of a receive-pack request body, up to the first
 * flush-pkt, from `chunks` (the body's async iterator; nothing after the chunk that holds the
 * flush-pkt is read). `shallow` lines are skipped; a signed push (`push-cert`), a malformed line,
 * a body that ends early or a list over {@link MAX_COMMANDS} / {@link MAX_COMMAND_BYTES} throws
 * {@link ReceivePackParseError}. An empty list (a bare flush-pkt: git's auth probe) is valid.
 */
export async function readReceivePackCommands(
  chunks: AsyncIterator<Buffer | string>,
): Promise<ReceivePackCommands> {
  let buf = Buffer.alloc(0);
  let pos = 0;
  const commands: RefCommand[] = [];
  let capabilities: string[] = [];
  for (;;) {
    // parse every complete pkt-line in the buffer
    while (buf.length - pos >= 4) {
      const lenHex = buf.toString("latin1", pos, pos + 4);
      if (!/^[0-9a-f]{4}$/i.test(lenHex)) throw new ReceivePackParseError("bad pkt-line length");
      const len = Number.parseInt(lenHex, 16);
      if (len === 0) return { commands, capabilities, prefix: buf };
      if (len < 4) throw new ReceivePackParseError("unexpected special pkt-line");
      if (buf.length - pos < len) break;
      let line = buf.toString("utf8", pos + 4, pos + len);
      pos += len;
      if (line.endsWith("\n")) line = line.slice(0, -1);
      if (commands.length === 0) {
        const nul = line.indexOf("\0");
        if (nul >= 0) {
          capabilities = line
            .slice(nul + 1)
            .split(" ")
            .filter((c) => c !== "");
          line = line.slice(0, nul);
        }
      }
      if (line.startsWith("push-cert")) {
        throw new ReceivePackParseError("signed pushes are not supported through the gateway");
      }
      if (SHALLOW.test(line)) continue;
      const parts = line.split(" ");
      const [oldId, newId, ref] = parts;
      if (
        parts.length !== 3 ||
        oldId === undefined ||
        newId === undefined ||
        ref === undefined ||
        !OBJECT_ID.test(oldId) ||
        !OBJECT_ID.test(newId) ||
        !ref.startsWith("refs/")
      ) {
        throw new ReceivePackParseError("malformed ref update command");
      }
      commands.push({ oldId, newId, ref });
      if (commands.length > MAX_COMMANDS) throw new ReceivePackParseError("too many ref updates");
    }
    if (buf.length > MAX_COMMAND_BYTES) throw new ReceivePackParseError("command list too long");
    const next = await chunks.next();
    if (next.done) throw new ReceivePackParseError("the request ended before the command list");
    const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
    buf = Buffer.concat([buf, chunk]);
  }
}

/**
 * A ref advertisement git turns into `fatal: remote error: <message>` (an `ERR` pkt-line as the
 * first packet: git dies on it before it reads anything else).
 */
export function advertisementError(message: string): Buffer {
  return pktLine(`ERR ${oneLine(message)}\n`);
}

/**
 * The answer to a refused receive-pack request, in the form the client asked for, so git prints
 * the message and marks each ref rejected:
 * - side-band(-64k): `message` on band 2 (git prints `remote: <message>`), then the report on
 *   band 1 (`unpack ok` + `ng <ref> <reason>`; git prints `! [remote rejected] … (<reason>)`);
 * - report-status(-v2) without side-band: the report alone;
 * - neither: an `ERR` pkt-line (git reports the push failed).
 */
export function receivePackRefusal(
  capabilities: readonly string[],
  refs: readonly string[],
  message: string,
  reason: string,
): Buffer {
  const caps = new Set(capabilities);
  const report = caps.has("report-status") || caps.has("report-status-v2");
  const sideBand = caps.has("side-band-64k") || caps.has("side-band");
  const why = oneLine(reason);
  const reportPkts = Buffer.concat([
    pktLine("unpack ok\n"),
    ...refs.map((ref) => pktLine(`ng ${ref} ${why}\n`)),
    FLUSH_PKT,
  ]);
  if (sideBand) {
    // side-band (without -64k) carries at most 1000 bytes per packet
    const max = caps.has("side-band-64k") ? MAX_PKT - 5 : 995;
    const band = (n: number, data: Buffer) => {
      const out: Buffer[] = [];
      for (let i = 0; i < data.length; i += max) {
        out.push(pktLine(Buffer.concat([Buffer.from([n]), data.subarray(i, i + max)])));
      }
      return out;
    };
    return Buffer.concat([
      ...band(2, Buffer.from(`${oneLine(message)}\n`, "utf8")),
      ...(report ? band(1, reportPkts) : []),
      FLUSH_PKT,
    ]);
  }
  if (report) return reportPkts;
  return pktLine(`ERR ${oneLine(message)}\n`);
}

/** A message on one line (pkt-line payloads git prints are line-based). */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
