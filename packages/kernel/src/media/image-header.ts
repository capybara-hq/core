export type SniffedImage = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_JPEG_SEGMENTS = 256;

function startsWith(bytes: Uint8Array, offset: number, text: number[] | string): boolean {
  const expected = typeof text === "string" ? [...text].map((c) => c.charCodeAt(0)) : text;
  if (bytes.length < offset + expected.length) return false;
  return expected.every((b, i) => bytes[offset + i] === b);
}

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number): number => u16le(b, o) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number): number =>
  (b[o] ?? 0) * 0x1000000 + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
const u32le = (b: Uint8Array, o: number): number => u24le(b, o) + (b[o + 3] ?? 0) * 0x1000000;

function size(width: number, height: number): { width?: number; height?: number } {
  return width > 0 && height > 0 ? { width, height } : {};
}

function pngSize(b: Uint8Array): { width?: number; height?: number } {
  if (b.length < 24 || !startsWith(b, 12, "IHDR")) return {};
  return size(u32be(b, 16), u32be(b, 20));
}

function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let pos = 2;
  for (let i = 0; i < MAX_JPEG_SEGMENTS; i++) {
    // Skip fill bytes, then read the marker.
    while (pos < b.length && b[pos] === 0xff && b[pos + 1] === 0xff) pos++;
    if (pos + 4 > b.length || b[pos] !== 0xff) return {};
    const marker = b[pos + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return {};
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 9 > b.length) return {};
      return size(u16be(b, pos + 7), u16be(b, pos + 5));
    }
    pos += 2 + u16be(b, pos + 2);
  }
  return {};
}

function gifSize(b: Uint8Array): { width?: number; height?: number } {
  if (b.length < 10) return {};
  return size(u16le(b, 6), u16le(b, 8));
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  if (startsWith(b, 12, "VP8 ")) {
    if (b.length < 30 || !startsWith(b, 23, [0x9d, 0x01, 0x2a])) return {};
    return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (startsWith(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return {};
    const bits = u32le(b, 21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (startsWith(b, 12, "VP8X")) {
    if (b.length < 30) return {};
    return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return {};
}

/**
 * Identifies an image by its magic bytes and reads the pixel size from the header when the
 * bytes cover it. Reads only the header, never decodes, and never throws on short input.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return { mediaType: "image/png", ...pngSize(bytes) };
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff]))
    return { mediaType: "image/jpeg", ...jpegSize(bytes) };
  if (startsWith(bytes, 0, "GIF87a") || startsWith(bytes, 0, "GIF89a")) {
    return { mediaType: "image/gif", ...gifSize(bytes) };
  }
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) {
    return { mediaType: "image/webp", ...webpSize(bytes) };
  }
  return null;
}
