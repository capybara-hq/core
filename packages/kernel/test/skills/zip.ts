import { deflateRawSync } from "node:zlib";

/** 测试用的 zip 条目：可故意写错大小、属性等，构造恶意包。 */
export interface ZipEntry {
  name: string;
  data?: Uint8Array | string;
  /** 0 = stored，8 = deflate（默认）。 */
  method?: 0 | 8;
  /** 外部属性（高 16 位为 Unix mode）；默认普通文件 0o100644。 */
  unixMode?: number;
  /** 覆盖中央目录里声明的解压后大小。 */
  declaredSize?: number;
  /** 置位加密标志。 */
  encrypted?: boolean;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 把条目打成 zip（UTF-8 文件名、无 zip64）。 */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw =
      typeof e.data === "string" ? Buffer.from(e.data) : Buffer.from(e.data ?? new Uint8Array());
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const flags = 0x800 | (e.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const mode = e.unixMode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const SKILL_MD = (name = "pdf-tools", description = "Work with PDFs.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nSteps.\n`;
