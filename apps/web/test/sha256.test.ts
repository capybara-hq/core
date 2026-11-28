import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Fallback, sha256Hex } from "../src/lib/sha256";

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);
const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sha256Fallback", () => {
  it("matches the known digest of four zero bytes", async () => {
    expect(await sha256Fallback(blobOf(new Uint8Array(4)))).toBe(
      "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
    );
  });

  it("hashes an empty blob", async () => {
    expect(await sha256Fallback(blobOf(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it.each([55, 56, 63, 64, 65, 1_048_576, 2_621_441])(
    "matches node's digest over %i bytes (padding edges, several slices)",
    async (n) => {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(await sha256Fallback(blobOf(bytes))).toBe(reference(bytes));
    },
  );

  it("is used when crypto.subtle is missing", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      expect(await sha256Hex(blobOf(new Uint8Array(4)))).toBe(
        "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
      );
    } finally {
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
    }
  });

  it("stops hashing when the signal aborts, between slices and before the result", async () => {
    const ctrl = new AbortController();
    const bytes = new Uint8Array(3 * 1_048_576);
    const blob = blobOf(bytes);
    const slice = blob.slice.bind(blob);
    let slices = 0;
    blob.slice = (...a: Parameters<Blob["slice"]>) => {
      slices += 1;
      if (slices === 2) ctrl.abort();
      return slice(...a);
    };
    await expect(sha256Fallback(blob, ctrl.signal)).rejects.toThrow();
    expect(slices).toBe(2);
    const done = new AbortController();
    done.abort();
    await expect(sha256Hex(blobOf(bytes), done.signal)).rejects.toThrow();
  });
});
