import { userInfo } from "node:os";

/**
 * A file name's bytes as the agent (Python, "surrogateescape") reads them: UTF-8, with each byte
 * outside a well-formed sequence as U+DC80–U+DCFF. JSON carries such a string to the agent, which
 * opens exactly the original bytes, so a directory whose name is not UTF-8 is granted, not lost.
 */
export function fsNameString(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    const n =
      b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let ok = n > 0 && i + n <= bytes.length;
    for (let k = 1; ok && k < n; k++) ok = ((bytes[i + k] as number) & 0xc0) === 0x80;
    if (ok) {
      const c = bytes[i + 1] as number;
      // no overlong forms, no encoded surrogates, nothing above U+10FFFF
      ok = !(
        (b === 0xe0 && c < 0xa0) ||
        (b === 0xed && c > 0x9f) ||
        (b === 0xf0 && c < 0x90) ||
        (b === 0xf4 && c > 0x8f)
      );
    }
    if (ok) {
      out += Buffer.from(bytes.subarray(i, i + n)).toString("utf8");
      i += n;
    } else {
      out += String.fromCharCode(0xdc00 + b);
      i++;
    }
  }
  return out;
}

/** The bytes {@link fsNameString} read (its inverse). */
export function fsNameBytes(name: string): Buffer {
  const parts: Buffer[] = [];
  let run = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const next = name.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      run += name.slice(i, i + 2); // a pair, whatever its low half
      i++;
    } else if (c >= 0xdc80 && c <= 0xdcff) {
      parts.push(Buffer.from(run, "utf8"), Buffer.of(c - 0xdc00));
      run = "";
    } else run += name[i];
  }
  parts.push(Buffer.from(run, "utf8"));
  return Buffer.concat(parts);
}

/**
 * The home directory as a file-system name ({@link fsNameString}): `homedir()`, unless it could
 * not be decoded as UTF-8 (it then holds U+FFFD), when the password database's bytes are read
 * instead, so paths built under it name the real directory.
 */
export function homeFsName(home: string): string {
  if (!home.includes("\uFFFD")) return home;
  try {
    return fsNameString(userInfo({ encoding: "buffer" }).homedir);
  } catch {
    return home;
  }
}
