import { describe, expect, it, vi } from "vitest";
import { shareOrCopy } from "../src/lib/share";

const input = { title: "T", url: "https://x.test/s/1" };

describe("shareOrCopy", () => {
  it("uses the shell's share@1 first", async () => {
    const share = vi.fn(async () => {});
    const webShare = vi.fn(async () => {});
    const copy = vi.fn(async () => {});
    await expect(shareOrCopy(input, { share: { share }, webShare, copy })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith(input);
    expect(webShare).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("uses Web Share without the shell capability", async () => {
    const webShare = vi.fn(async () => {});
    const copy = vi.fn(async () => {});
    await expect(shareOrCopy(input, { webShare, copy })).resolves.toBe("shared");
    expect(webShare).toHaveBeenCalledWith(input);
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies the link when nothing can share", async () => {
    const copy = vi.fn(async () => {});
    await expect(shareOrCopy(input, { copy })).resolves.toBe("copied");
    expect(copy).toHaveBeenCalledWith(input.url);
  });

  it("counts a dismissed Web Share as shared and copies nothing", async () => {
    const webShare = vi.fn(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    const copy = vi.fn(async () => {});
    await expect(shareOrCopy(input, { webShare, copy })).resolves.toBe("shared");
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies when Web Share refuses for another reason", async () => {
    const webShare = vi.fn(async () => {
      throw new DOMException("no", "NotAllowedError");
    });
    const copy = vi.fn(async () => {});
    await expect(shareOrCopy(input, { webShare, copy })).resolves.toBe("copied");
  });
});
