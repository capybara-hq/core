import { describe, expect, it } from "vitest";
import {
  IMAGES,
  imageRef,
  isPrerelease,
  planImages,
  type TagState,
  tagState,
} from "../src/images.js";

const all = (s: TagState) =>
  Object.fromEntries(IMAGES.map((i) => [i.image, s])) as Record<string, TagState>;
const names = (p: { build: { image: string }[] }) => p.build.map((t) => t.image);

describe("IMAGES", () => {
  it("are the four images: three kernel roles from one Dockerfile, plus web", () => {
    expect(IMAGES).toEqual([
      {
        image: "capybara-api",
        dockerfile: "docker/kernel.Dockerfile",
        roles: "api",
        cache: "kernel",
      },
      {
        image: "capybara-worker",
        dockerfile: "docker/kernel.Dockerfile",
        roles: "worker",
        cache: "kernel",
      },
      {
        image: "capybara-gateway",
        dockerfile: "docker/kernel.Dockerfile",
        roles: "gateway",
        cache: "kernel",
      },
      { image: "capybara-web", dockerfile: "docker/web.Dockerfile", roles: "", cache: "web" },
    ]);
    expect(imageRef("capybara-api")).toBe("ghcr.io/capybara-hq/capybara-api");
  });
});

describe("isPrerelease", () => {
  it.each([
    ["0.1.0", false],
    ["1.2.3", false],
    ["0.2.0-rc.1", true],
    ["1.0.0-beta", true],
  ])("%s -> %s", (v, expected) => expect(isPrerelease(v)).toBe(expected));
});

describe("planImages", () => {
  const base = { version: "0.2.0", npmReleased: true };

  it("rejects a version that is not a plain semver usable as an image tag", () => {
    for (const version of ["0.2", "v0.2.0", "0.2.0+build.1", "0.2.0 latest", "", "0.2.0-"]) {
      expect(() => planImages({ ...base, version, mode: "manual", tags: all("missing") })).toThrow(
        /version/,
      );
    }
  });

  describe("auto (push to main)", () => {
    it("publishes nothing before the first npm release (P-16: the first release is manual)", () => {
      const p = planImages({ ...base, npmReleased: false, mode: "auto", tags: all("missing") });
      expect(p).toMatchObject({ push: false, build: [] });
      expect(p.reason).toMatch(/first release/);
    });

    it("does nothing when every image already has the version tag", () => {
      const p = planImages({ ...base, mode: "auto", tags: all("present") });
      expect(p).toMatchObject({ push: false, build: [] });
    });

    it("builds and pushes only the images missing the version tag (self-healing)", () => {
      const tags: Record<string, TagState> = {
        ...all("present"),
        "capybara-worker": "missing",
        "capybara-web": "missing",
      };
      const p = planImages({ ...base, mode: "auto", tags });
      expect(p.push).toBe(true);
      expect(names(p)).toEqual(["capybara-worker", "capybara-web"]);
    });

    it("fails when it cannot tell whether a tag exists (no access, package not public)", () => {
      const tags = { ...all("present"), "capybara-api": "denied" as const };
      expect(() => planImages({ ...base, mode: "auto", tags })).toThrow(/capybara-api/);
    });

    it("requires a state for every image", () => {
      expect(() => planImages({ ...base, mode: "auto", tags: {} })).toThrow(/capybara-api/);
    });
  });

  describe("manual (workflow_dispatch)", () => {
    it("the first release: packages that don't exist yet read as denied and get built", () => {
      const p = planImages({ ...base, npmReleased: false, mode: "manual", tags: all("denied") });
      expect(p.push).toBe(true);
      expect(names(p)).toEqual(IMAGES.map((i) => i.image));
    });

    it("skips images that already have the version tag", () => {
      const tags = { ...all("present"), "capybara-gateway": "missing" as const };
      const p = planImages({ ...base, mode: "manual", tags });
      expect(names(p)).toEqual(["capybara-gateway"]);
      expect(planImages({ ...base, mode: "manual", tags: all("present") })).toMatchObject({
        push: false,
        build: [],
      });
    });
  });

  describe("dry-run", () => {
    it("builds every image and pushes nothing, whatever the registry has", () => {
      const p = planImages({ ...base, npmReleased: false, mode: "dry-run", tags: {} });
      expect(p.push).toBe(false);
      expect(names(p)).toEqual(IMAGES.map((i) => i.image));
    });
  });

  it("tags latest only for a non-prerelease version", () => {
    const tags = all("missing");
    expect(planImages({ ...base, mode: "manual", tags }).latest).toBe(true);
    expect(planImages({ ...base, version: "0.3.0-rc.1", mode: "manual", tags }).latest).toBe(false);
  });
});

describe("tagState", () => {
  type Call = { url: string; init: RequestInit | undefined };
  const fakeFetch = (token: number, manifest: number, calls: Call[] = []) =>
    (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/token?")) {
        return token === 200
          ? Response.json({ token: "registry-token" })
          : Response.json({ errors: [{ code: "DENIED" }] }, { status: token });
      }
      return new Response(null, { status: manifest });
    }) as typeof fetch;

  it("asks for a pull token with the GitHub token, then HEADs the tag's manifest", async () => {
    const calls: Call[] = [];
    const s = await tagState("capybara-api", "0.2.0", {
      fetch: fakeFetch(200, 200, calls),
      githubToken: "gh-secret",
    });
    expect(s).toBe("present");
    expect(calls[0]?.url).toBe(
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Acapybara-hq%2Fcapybara-api%3Apull",
    );
    const auth = new Headers(calls[0]?.init?.headers).get("authorization") ?? "";
    expect(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString()).toBe(
      "x-access-token:gh-secret",
    );
    expect(calls[1]?.url).toBe("https://ghcr.io/v2/capybara-hq/capybara-api/manifests/0.2.0");
    expect(calls[1]?.init?.method).toBe("HEAD");
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe("Bearer registry-token");
    expect(new Headers(calls[1]?.init?.headers).get("accept")).toContain(
      "application/vnd.oci.image.index.v1+json",
    );
  });

  it("anonymous without a GitHub token", async () => {
    const calls: Call[] = [];
    await tagState("capybara-web", "0.2.0", { fetch: fakeFetch(200, 404, calls) });
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false);
  });

  it.each([
    [200, 200, "present"],
    [200, 404, "missing"],
    [403, 0, "denied"],
    [401, 0, "denied"],
    [200, 401, "denied"],
    [200, 403, "denied"],
  ] as const)("token %i, manifest %i -> %s", async (token, manifest, expected) => {
    expect(await tagState("capybara-api", "0.2.0", { fetch: fakeFetch(token, manifest) })).toBe(
      expected,
    );
  });

  it("throws on anything else, so a registry outage never reads as 'missing'", async () => {
    await expect(tagState("capybara-api", "0.2.0", { fetch: fakeFetch(500, 0) })).rejects.toThrow(
      /500/,
    );
    await expect(tagState("capybara-api", "0.2.0", { fetch: fakeFetch(200, 502) })).rejects.toThrow(
      /502/,
    );
  });
});
