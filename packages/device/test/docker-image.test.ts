import { describe, expect, it } from "vitest";
import {
  IMAGE_REPOSITORY_ENV,
  imageRepository,
  matchPinnedImage,
  pinnedPlatform,
  SANDBOX_IMAGE_PIN,
  sandboxImageReference,
  unpinnedArchitectureProblem,
} from "../src/exec/docker-image.js";

const pin = SANDBOX_IMAGE_PIN;

describe("the sandbox image pin", () => {
  it("references the image by the pinned index digest", () => {
    expect(sandboxImageReference({})).toBe(`${pin.repository}@${pin.index}`);
  });

  it("lets a mirror replace the repository only; the digest stays pinned", () => {
    const env = { [IMAGE_REPOSITORY_ENV]: "registry.example.com:5000/mirror/capybara-sandbox" };
    expect(sandboxImageReference(env)).toBe(
      `registry.example.com:5000/mirror/capybara-sandbox@${pin.index}`,
    );
    expect(imageRepository({ [IMAGE_REPOSITORY_ENV]: "" })).toBe(pin.repository);
    for (const bad of [
      "registry.example.com/sandbox:latest",
      `registry.example.com/sandbox@${pin.index}`,
      "Registry.example.com/Sandbox",
      "registry.example.com/sandbox,readonly",
      "registry.example.com/sandbox extra",
      "registry.example.com/../x",
    ])
      expect(() => imageRepository({ [IMAGE_REPOSITORY_ENV]: bad }), bad).toThrow(
        IMAGE_REPOSITORY_ENV,
      );
  });

  it("maps Node's and Docker's architecture names to the pinned platforms", () => {
    expect(["x64", "x86_64", "amd64"].map(pinnedPlatform)).toEqual(["amd64", "amd64", "amd64"]);
    expect(["arm64", "aarch64"].map(pinnedPlatform)).toEqual(["arm64", "arm64"]);
    expect(pinnedPlatform("s390x")).toBeUndefined();
    expect(unpinnedArchitectureProblem("arm64")).toBeUndefined();
    expect(unpinnedArchitectureProblem("ppc64")).toMatch(/not available on this architecture/);
  });

  it("accepts only the pinned index, or the platform's manifest or config digest", () => {
    expect(matchPinnedImage(pin.index, "amd64")).toBe("index");
    expect(matchPinnedImage(pin.index, undefined)).toBe("index");
    expect(matchPinnedImage(pin.platforms.amd64.manifest, "amd64")).toBe("manifest");
    expect(matchPinnedImage(pin.platforms.amd64.config, "amd64")).toBe("config");
    expect(matchPinnedImage(pin.platforms.arm64.config, "arm64")).toBe("config");
    // another platform's digests, another image, a tag, no platform
    expect(matchPinnedImage(pin.platforms.arm64.config, "amd64")).toBeUndefined();
    expect(matchPinnedImage(pin.platforms.amd64.manifest, "arm64")).toBeUndefined();
    expect(matchPinnedImage(`sha256:${"0".repeat(64)}`, "amd64")).toBeUndefined();
    expect(matchPinnedImage(pin.version, "amd64")).toBeUndefined();
    expect(matchPinnedImage(pin.platforms.amd64.config, undefined)).toBeUndefined();
  });
});
