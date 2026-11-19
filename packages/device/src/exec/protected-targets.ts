import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** `path` in on-disk form when it exists (case and Unicode normalization as stored). */
export function onDisk(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * How `path` resolves, one component at a time with `lstat` and `readlink`: every symbolic link
 * met on the way (each link's own location, wherever in the chain it sits) and the final target
 * (its existing part in on-disk form, the missing names appended). A dangling link is followed to
 * the location it names. A link loop stops the walk; the links met so far are still returned.
 *
 * Shared by the device workers (macOS and Linux): each link and the target become anchored denies
 * (the SDK `sandbox-write-denies.ts` constraint on consumers), so no hop of a dotfile manager's
 * chain can be swapped for a real directory.
 */
export function protectedChain(path: string): { links: string[]; target: string } {
  const links: string[] = [];
  let pending = path.split("/").filter((part) => part !== "");
  let current = "/";
  for (let hops = 0; pending.length > 0; ) {
    const name = pending.shift() as string;
    if (name === ".") continue;
    // `current` is always a real directory here, so `..` is its physical parent
    const next = name === ".." ? dirname(current) : join(current, name);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      // missing from here on: the rest would be created below the existing part
      return { links, target: join(onDisk(current), name, ...pending) };
    }
    if (!link) {
      current = next;
      continue;
    }
    links.push(next);
    if (++hops > 40) return { links, target: path };
    const to = readlinkSync(next);
    pending = [...to.split("/").filter((part) => part !== ""), ...pending];
    if (to.startsWith("/")) current = "/";
  }
  return { links, target: onDisk(current) };
}
