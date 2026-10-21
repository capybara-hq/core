import { crc32, deflateSync } from "node:zlib";

/**
 * 一致性套件与夹具用的媒体样本：运行时生成，不在仓库里放二进制文件。
 * - {@link redPngBase64}：64×64 纯红 PNG（真实模型能稳定答出颜色）；
 * - {@link pdfBase64}：一页、只印一个单词的最小 PDF（Helvetica，偏移表按实际字节计算）。
 */

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** 纯色 PNG（8 位 RGB），返回 base64。 */
export function solidPngBase64(rgb: [number, number, number], size = 64): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色
  const row = 1 + size * 3;
  const raw = Buffer.alloc(size * row);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(rgb, y * row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/** 64×64 纯红 PNG 的 base64。 */
export const redPngBase64 = (): string => solidPngBase64([255, 0, 0]);

/** 一页 PDF，页面上只印 `word`（大写字母与数字），返回 base64。 */
export function pdfBase64(word: string): string {
  if (!/^[A-Z0-9]+$/.test(word)) throw new Error("pdfBase64: word must be [A-Z0-9]+");
  const stream = `BT /F1 36 Tf 72 700 Td (${word}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

/** 夹具用：base64 是否为 PNG（看文件头）。 */
export function isPngBase64(data: unknown): boolean {
  if (typeof data !== "string") return false;
  return Buffer.from(data, "base64").subarray(0, 4).toString("latin1") === "\x89PNG";
}

/** 夹具用：从 {@link pdfBase64} 生成的 PDF 里读出印的词；不是这样的 PDF 时返回 null。 */
export function pdfSampleWord(data: unknown): string | null {
  if (typeof data !== "string") return null;
  const pdf = Buffer.from(data, "base64").toString("latin1");
  if (!pdf.startsWith("%PDF-")) return null;
  return /\(([A-Z0-9]+)\) Tj/.exec(pdf)?.[1] ?? null;
}
