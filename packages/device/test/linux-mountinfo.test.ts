import { describe, expect, it } from "vitest";
import {
  decodeMountinfoField,
  linuxMountReexposures,
  MountinfoError,
  machineReachMountRefusal,
  mountReexposures,
  parseMountinfo,
} from "../src/exec/linux-mountinfo.js";

/** One mountinfo line: `id parent dev root mountPoint` plus the rest of a real line. */
const line = (
  id: number,
  parent: number,
  dev: string,
  root: string,
  mountPoint: string,
  fsType = "ext4",
  superOptions = "rw",
  optional = "shared:1",
) =>
  `${id} ${parent} ${dev} ${root} ${mountPoint} rw,relatime ${optional} - ${fsType} /dev/x ${superOptions}`;

const table = (...lines: string[]) => `${lines.join("\n")}\n`;
/** The root file system and /proc, on separate devices. */
const BASE = [line(21, 1, "8:1", "/", "/"), line(22, 21, "0:20", "/", "/proc", "proc")];
const SSH = "/home/u/.ssh";
const reexposed = (text: string, denied: string[] = [SSH]) =>
  mountReexposures(parseMountinfo(text), denied);

describe("parseMountinfo", () => {
  it("parses the fields, optional fields of any count, and the separator", () => {
    const [a, b] = parseMountinfo(
      table(
        "21 1 8:1 / / rw,relatime shared:1 master:2 - ext4 /dev/sda1 rw,errors=remount-ro",
        "30 21 0:5 / /dev rw - devtmpfs udev rw,size=10k",
      ),
    );
    expect(a).toEqual({
      mountId: 21,
      parentId: 1,
      dev: "8:1",
      root: "/",
      mountPoint: "/",
      fsType: "ext4",
      source: "/dev/sda1",
      superOptions: ["rw", "errors=remount-ro"],
    });
    expect(b?.mountPoint).toBe("/dev");
    expect(b?.superOptions).toEqual(["rw", "size=10k"]);
  });
  it("decodes octal escapes in roots and mount points", () => {
    const [, e] = parseMountinfo(
      table(BASE[0] as string, line(40, 21, "8:1", "/home/u/my\\040keys", "/mnt/a\\011b\\134c")),
    );
    expect(e?.root).toBe("/home/u/my keys");
    expect(e?.mountPoint).toBe("/mnt/a\tb\\c");
  });
  it("decodes escaped UTF-8 bytes and keeps raw UTF-8 text", () => {
    expect(decodeMountinfoField("/h/\\303\\251t\\303\\251")).toBe("/h/été");
    expect(decodeMountinfoField("/h/été")).toBe("/h/été");
  });
  it("accepts an empty mount source", () => {
    const [, e] = parseMountinfo(table(BASE[0] as string, "30 21 0:40 / /x rw - tmpfs  rw"));
    expect(e?.source).toBe("");
    expect(e?.mountPoint).toBe("/x");
  });
  it("refuses an escape it cannot decode", () => {
    for (const bad of ["/a\\04", "/a\\x41b", "/a\\400", "/a\\", "/a\\377"])
      expect(() => decodeMountinfoField(bad), bad).toThrow(MountinfoError);
  });
  it("refuses malformed lines and an empty table", () => {
    const bad = [
      "",
      "21 1 8:1 / / rw - ext4 /dev/sda1", // missing super options
      "21 1 8:1 / / rw - ext4 /dev/sda1 rw extra",
      "21 1 8:1 / / rw shared:1 ext4 /dev/sda1 rw", // no separator
      "x 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "21 1 81 / / rw - ext4 /dev/sda1 rw",
      "21 1 8:1 / relative rw - ext4 /dev/sda1 rw",
      "21 1 8:1 / /  rw - ext4 /dev/sda1 rw", // an empty field
    ];
    for (const text of bad) expect(() => parseMountinfo(`${text}\n`), text).toThrow(MountinfoError);
    expect(() => parseMountinfo(table(BASE[0] as string, "", BASE[1] as string))).toThrow(
      MountinfoError,
    );
  });
});

describe("mountReexposures", () => {
  it("finds nothing on a table without other mounts of the denied path's file system", () => {
    expect(reexposed(table(...BASE, line(23, 21, "0:30", "/", "/tmp", "tmpfs")))).toEqual({
      paths: [],
      problem: null,
    });
  });
  it("a bind mount of the denied directory re-exposes it at its mount point", () => {
    expect(reexposed(table(...BASE, line(40, 21, "8:1", SSH, "/mnt/keys"))).paths).toEqual([
      "/mnt/keys",
    ]);
  });
  it("a bind mount of something inside the denied directory re-exposes it", () => {
    expect(
      reexposed(table(...BASE, line(40, 21, "8:1", `${SSH}/id_ed25519`, "/srv/key"))).paths,
    ).toEqual(["/srv/key"]);
  });
  it("a mount of an ancestor's subtree shows the denied directory below its mount point", () => {
    expect(reexposed(table(...BASE, line(40, 21, "8:1", "/home", "/mnt/h"))).paths).toEqual([
      "/mnt/h/u/.ssh",
    ]);
    // the whole root file system mounted again
    expect(reexposed(table(...BASE, line(40, 21, "8:1", "/", "/mnt/root"))).paths).toEqual([
      "/mnt/root/home/u/.ssh",
    ]);
  });
  it("locates the denied path in its own file system (a separate /home)", () => {
    const text = table(
      ...BASE,
      line(30, 21, "8:2", "/", "/home"),
      // another device's /u/.ssh is not the denied directory
      line(40, 21, "8:2", "/u", "/srv/u"),
      line(41, 21, "8:3", "/u/.ssh", "/elsewhere"),
      // the root file system's /home/u/.ssh, covered by the /home mount: still denied (content
      // hidden under an over-mount counts)
      line(42, 21, "8:1", "/home", "/srv/roothome"),
    );
    expect([...reexposed(text).paths].sort()).toEqual(["/srv/roothome/u/.ssh", "/srv/u/.ssh"]);
  });
  it("counts every stacked mount, the covered ones included", () => {
    const text = table(
      ...BASE,
      line(30, 21, "8:2", "/", "/home"),
      // mounted over /home: its parent is the mount it covers
      line(31, 30, "8:3", "/", "/home"),
      line(40, 21, "8:2", "/u", "/srv/old"),
      line(41, 21, "8:3", "/u", "/srv/new"),
    );
    expect([...reexposed(text).paths].sort()).toEqual(["/srv/new/.ssh", "/srv/old/.ssh"]);
  });
  it("a mount over an ancestor hides an older mount below it", () => {
    const text = table(
      ...BASE,
      // /home/u/.ssh was a mount of 8:4, then /home was mounted over (both children of /)
      line(29, 21, "8:4", "/keys", SSH),
      line(30, 21, "8:2", "/", "/home"),
      line(40, 21, "8:2", "/u", "/srv/u"),
    );
    const { paths } = reexposed(text);
    expect(paths).toContain("/srv/u/.ssh");
  });
  it("a mount inside the denied directory re-exposes it where its file system shows again", () => {
    const text = table(
      ...BASE,
      line(30, 21, "8:5", "/vault", `${SSH}/vault`),
      line(40, 21, "8:5", "/vault", "/opt/vault"),
      line(41, 21, "8:5", "/", "/opt/disk"),
    );
    expect([...reexposed(text).paths].sort()).toEqual(["/opt/disk/vault", "/opt/vault"]);
  });
  it("a mount point under a denied path is already denied and not repeated", () => {
    expect(reexposed(table(...BASE, line(40, 21, "8:1", "/home", `${SSH}/h`))).paths).toEqual([]);
  });
  it("reads an unlinked root (//deleted) as the directory it was", () => {
    const text = table(...BASE, line(40, 21, "8:1", "/home/u/.ssh//deleted", "/mnt/gone"));
    expect(reexposed(text).paths).toEqual(["/mnt/gone"]);
    // a name ending in " (deleted)" is just a name
    const named = table(...BASE, line(40, 21, "8:1", "/home/u/.ssh\\040(deleted)", "/mnt/x"));
    expect(reexposed(named).paths).toEqual([]);
  });
  it("a root that is not a path stands for the whole file system", () => {
    const text = table(
      ...BASE,
      line(30, 21, "0:4", "net:[4026531840]", `${SSH}/ns`, "nsfs"),
      line(40, 21, "0:4", "net:[4026531840]", "/run/netns/x", "nsfs"),
    );
    expect(reexposed(text).paths).toEqual(["/run/netns/x"]);
  });
  it("btrfs subvolumes share a device: roots within the file system decide", () => {
    const text = table(
      line(21, 1, "0:33", "/@", "/", "btrfs", "rw,subvol=/@"),
      line(30, 21, "0:33", "/@home", "/home", "btrfs", "rw,subvol=/@home"),
      line(40, 21, "0:33", "/@home/u", "/backup/u", "btrfs", "rw,subvol=/@home"),
      line(41, 21, "0:33", "/@snapshots", "/snap", "btrfs", "rw"),
    );
    expect(reexposed(text).paths).toEqual(["/backup/u/.ssh"]);
  });
  it("an overlay whose layer holds or lies in a denied path re-exposes it", () => {
    const text = table(
      ...BASE,
      line(
        50,
        21,
        "0:60",
        "/",
        "/merged",
        "overlay",
        "rw,lowerdir=/home/u:/layers/a\\134:b,upperdir=/up,workdir=/home/u/.ssh/w",
      ),
      line(
        51,
        21,
        "0:61",
        "/",
        "/m2",
        "overlay",
        `rw,lowerdir=${SSH}/sub,upperdir=/up2,workdir=/w2`,
      ),
      line(52, 21, "0:62", "/", "/m3", "overlay", "rw,lowerdir=/a,upperdir=/b,workdir=/c"),
    );
    expect([...reexposed(text).paths].sort()).toEqual(["/m2", "/merged/.ssh"]);
  });
  it("splits super options before decoding, so an escaped comma stays in its value", () => {
    const text = table(
      ...BASE,
      line(
        50,
        21,
        "0:60",
        "/",
        "/merged",
        "overlay",
        "rw,lowerdir=/home/u\\054x:/home/u,upperdir=/up",
      ),
    );
    expect(reexposed(text).paths).toEqual(["/merged/.ssh"]);
  });
  it("an overlay with a relative or unresolvable layer is denied with every mount of it", () => {
    const relative = table(
      ...BASE,
      // moby's overlay2 writes short relative layer names
      line(
        50,
        21,
        "0:60",
        "/",
        "/var/lib/docker/overlay2/x/merged",
        "overlay",
        "rw,lowerdir=l/ABC:l/DEF,upperdir=/up",
      ),
      line(51, 21, "0:60", "/etc", "/srv/etc"),
    );
    expect(reexposed(relative)).toEqual({
      paths: ["/var/lib/docker/overlay2/x/merged", "/srv/etc"],
      problem: null,
    });
    const gone = table(
      ...BASE,
      line(50, 21, "0:60", "/", "/merged", "overlay", "rw,lowerdir=/gone,upperdir=/up"),
    );
    const realpath = (p: string) => (p === "/gone" ? null : p);
    expect(mountReexposures(parseMountinfo(gone), [SSH], { realpath })).toEqual({
      paths: ["/merged"],
      problem: null,
    });
  });
  it("unknown content holding the device's own directories is a problem, not a deny", () => {
    const text = table(
      line(21, 1, "0:60", "/", "/", "overlay", "rw,lowerdir=/var/lib/docker/l/A,upperdir=/up"),
    );
    const r = mountReexposures(parseMountinfo(text), [SSH], {
      realpath: () => null,
      keep: ["/home/u/capybara/workspace"],
    });
    expect(r.paths).toEqual([]);
    expect(r.problem).toMatch(/cannot resolve .* holds this device's own directories/);
  });
  it("canonicalizes absolute overlay layers before the in/holds test", () => {
    const text = table(
      ...BASE,
      line(50, 21, "0:60", "/", "/merged", "overlay", "rw,lowerdir=/link-to-home,upperdir=/up"),
    );
    const realpath = (p: string) => (p === "/link-to-home" ? "/home/u" : p);
    expect(mountReexposures(parseMountinfo(text), [SSH], { realpath }).paths).toEqual([
      "/merged/.ssh",
    ]);
  });
  it("iterates to a fixed point: a re-exposure re-exposed elsewhere", () => {
    const text = table(
      ...BASE,
      line(40, 21, "8:1", SSH, "/mnt/keys"),
      // an overlay layered on the bind mount: found only once /mnt/keys is denied
      line(50, 21, "0:60", "/", "/merged", "overlay", "rw,lowerdir=/mnt/keys,upperdir=/up"),
    );
    expect(reexposed(text).paths).toEqual(["/mnt/keys", "/merged"]);
  });
  it("a non-recursive bind's mount point is not followed into another mount's copy", () => {
    const text = table(
      ...BASE,
      line(30, 21, "8:2", "/", "/data"),
      line(40, 30, "8:1", SSH, "/data/keys"),
      // /data's disk again: its keys directory is the empty mount point, not the bind
      line(41, 21, "8:2", "/", "/mnt/data"),
    );
    expect(reexposed(text).paths).toEqual(["/data/keys"]);
  });
  it("settles when a subtree is mounted inside itself", () => {
    const text = table(...BASE, line(40, 21, "8:1", "/home", "/home/sub"));
    expect(reexposed(text)).toEqual({ paths: ["/home/sub/u/.ssh"], problem: null });
  });
  it("a fixed point beyond the limits is a problem", () => {
    const text = table(...BASE, line(40, 21, "8:1", "/home", "/mnt/h"));
    const r = mountReexposures(parseMountinfo(text), [SSH], {
      limits: { paths: 0, rounds: 32, pathLength: 4096 },
    });
    expect(r.problem).toMatch(/do not settle/);
    expect(
      mountReexposures(parseMountinfo(text), [SSH], {
        limits: { paths: 10, rounds: 1, pathLength: 4096 },
      }).problem,
    ).toMatch(/do not settle/);
  });
  it("a denied path no mount holds is a problem", () => {
    expect(reexposed(table(line(30, 1, "8:2", "/", "/data")), [SSH]).problem).toMatch(
      /no mount .* holds \/home\/u\/\.ssh/,
    );
  });
  it("follows every candidate when siblings tie on one mount point", () => {
    const text = table(
      ...BASE,
      line(30, 21, "8:2", "/", "/home"),
      line(31, 21, "8:3", "/", "/home"),
      line(40, 21, "8:2", "/u", "/a"),
      line(41, 21, "8:3", "/u", "/b"),
    );
    expect([...reexposed(text).paths].sort()).toEqual(["/a/.ssh", "/b/.ssh"]);
  });
});

describe("automount points and loop devices", () => {
  const autofs = (id: number, point: string, mode: string) =>
    line(
      id,
      21,
      `0:${id}`,
      "/",
      point,
      "autofs",
      `rw,fd=5,pgrp=1,timeout=0,minproto=5,maxproto=5,${mode}`,
    );
  it("denies a direct or offset automount point with nothing mounted on it", () => {
    const text = table(
      ...BASE,
      autofs(60, "/mnt/auto", "direct"),
      autofs(61, "/srv/off", "offset"),
    );
    expect(reexposed(text).paths).toEqual(["/mnt/auto", "/srv/off"]);
  });
  it("follows what is mounted on a direct point instead of denying it", () => {
    const text = table(
      ...BASE,
      autofs(60, "/mnt/auto", "direct"),
      line(70, 60, "8:9", "/", "/mnt/auto"),
    );
    expect(reexposed(text).paths).toEqual([]);
  });
  it("denies an indirect point unless it holds a denied path or a directory the device needs", () => {
    const text = table(
      ...BASE,
      autofs(60, "/net", "indirect"),
      autofs(61, "/home", "indirect"),
      autofs(62, "/proj", "indirect"),
    );
    expect(mountReexposures(parseMountinfo(text), [SSH], { keep: ["/proj/app"] }).paths).toEqual([
      "/net",
    ]);
  });
  it("leaves the binfmt_misc automount alone", () => {
    expect(
      reexposed(table(...BASE, autofs(60, "/proc/sys/fs/binfmt_misc", "direct"))).paths,
    ).toEqual([]);
  });
  it("a loop device backed by a file in a denied directory shows it wholly", () => {
    const loop = (id: number, dev: string, source: string, point: string) =>
      `${id} 21 ${dev} / ${point} ro,relatime shared:9 - squashfs ${source} ro`;
    const text = table(
      ...BASE,
      loop(80, "7:0", "/dev/loop0", "/mnt/img"),
      loop(81, "7:1", "/dev/loop1p1", "/snap/core/1"),
      loop(82, "7:2", "/dev/loop2", "/mnt/old"),
    );
    const backing: Record<number, string> = {
      0: `${SSH}/vault.img`,
      1: "/var/lib/snapd/snaps/core_1.snap",
      2: `${SSH}/old.img (deleted)`,
    };
    expect(
      mountReexposures(parseMountinfo(text), [SSH], { loopBackingFile: (n) => backing[n] ?? null })
        .paths,
    ).toEqual(["/mnt/img", "/mnt/old"]);
    // a backing file it cannot read denies that loop device's mounts
    expect(mountReexposures(parseMountinfo(text), [SSH]).paths).toEqual([
      "/mnt/img",
      "/snap/core/1",
      "/mnt/old",
    ]);
  });
});

describe("linuxMountReexposures", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it("reads the table through the seam", () => {
    const r = linuxMountReexposures([SSH], {
      read: () => enc(table(...BASE, line(40, 21, "8:1", SSH, "/mnt/keys"))),
      realpath: (p) => p,
    });
    expect(r).toEqual({ paths: ["/mnt/keys"], problem: null });
  });
  it("an unreadable, non-UTF-8 or malformed table is a problem with no paths", () => {
    const unreadable = linuxMountReexposures([SSH], {
      read: () => {
        throw Object.assign(new Error("nope"), { code: "EACCES" });
      },
    });
    expect(unreadable).toEqual({
      paths: [],
      problem: "/proc/self/mountinfo cannot be read (EACCES)",
    });
    expect(linuxMountReexposures([SSH], { read: () => new Uint8Array([0x2f, 0xff]) }).problem).toBe(
      "/proc/self/mountinfo is not valid UTF-8",
    );
    expect(linuxMountReexposures([SSH], { read: () => enc("garbage\n") }).problem).toMatch(
      /^\/proc\/self\/mountinfo has a line it cannot parse/,
    );
    expect(
      linuxMountReexposures([SSH], { read: () => enc(table(line(1, 0, "8:1", "/\\9", "/"))) })
        .problem,
    ).toMatch(/an escape it cannot decode/);
  });
  it("the refusal names the cause, that fixing it restores machine reach, and the paths trust", () => {
    const text = machineReachMountRefusal("/proc/self/mountinfo cannot be read (EACCES)");
    expect(text).toContain("(/proc/self/mountinfo cannot be read (EACCES))");
    expect(text).toContain("fixing that cause restores it");
    expect(text).toContain("capybara-device ceiling set --project-reach paths");
    expect(text).toContain("which you trust not to hold a second view of a denied directory");
  });
});
