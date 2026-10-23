import { describe, expect, it } from "vitest";
import {
  compareSemver,
  IMAGES,
  imageRef,
  isPrerelease,
  listTags,
  planImages,
  type TagState,
  tagState,
  takesLatest,
} from "../src/images.js";

const all = (s: TagState) =>
  Object.fromEntries(IMAGES.map((i) => [i.image, s])) as Record<string, TagState>;
const names = (p: { build: { image: string }[] }) => p.build.map((t) => t.image);
/** `latest` of every planned image (all equal unless a lookup was denied). */
const latestOf = (p: { build: { latest: boolean }[] }) => {
  const set = [...new Set(p.build.map((t) => t.latest))];
  if (set.length !== 1) throw new Error(`mixed latest: ${JSON.stringify(p.build)}`);
  return set[0];
};

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

    it("builds only the version it is given, whatever newer tags exist (re-run of an old run)", () => {
      const p = planImages({
        ...base,
        version: "0.1.0",
        mode: "auto",
        tags: all("missing"),
        existingTags: ["0.1.1", "0.2.0", "latest"],
      });
      expect(p).toMatchObject({ version: "0.1.0", push: true });
      expect(names(p)).toEqual(IMAGES.map((i) => i.image));
      expect(latestOf(p)).toBe(false);
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

    it("after the first release, a denied lookup drops latest for that image only", () => {
      const tags = { ...all("missing"), "capybara-web": "denied" as const };
      const p = planImages({ ...base, mode: "manual", tags, existingTags: ["0.1.0"] });
      expect(names(p)).toEqual(IMAGES.map((i) => i.image));
      expect(Object.fromEntries(p.build.map((t) => [t.image, t.latest]))).toEqual({
        "capybara-api": true,
        "capybara-worker": true,
        "capybara-gateway": true,
        "capybara-web": false,
      });
      // The first release: denied means "doesn't exist yet", so latest stays.
      const first = planImages({
        ...base,
        npmReleased: false,
        mode: "manual",
        tags: all("denied"),
      });
      expect(latestOf(first)).toBe(true);
    });

    it("every package denied, no tags, npm shows only this tree's versions: first image release keeps latest", () => {
      // npm already shows the version (the publish job ran first in the same run), and nothing else.
      const p = planImages({
        ...base,
        mode: "manual",
        tags: all("denied"),
        existingTags: [],
        npmOnlyTreeVersions: true,
      });
      expect(names(p)).toEqual(IMAGES.map((i) => i.image));
      expect(latestOf(p)).toBe(true);
    });

    it("every lookup denied but npm shows other versions: a re-run while access is denied, no latest", () => {
      // listTags reads [] when access is denied, so the registry alone can't tell this from a first
      // release; npm can: a newer version exists, and latest must not move back to this one.
      for (const npmOnlyTreeVersions of [false, undefined]) {
        const p = planImages({
          ...base,
          mode: "manual",
          tags: all("denied"),
          existingTags: [],
          ...(npmOnlyTreeVersions !== undefined && { npmOnlyTreeVersions }),
        });
        expect(names(p)).toEqual(IMAGES.map((i) => i.image));
        expect(p.build.some((t) => t.latest)).toBe(false);
      }
    });

    it("every lookup denied but some tag exists: not a first release, latest dropped", () => {
      const p = planImages({
        ...base,
        mode: "manual",
        tags: all("denied"),
        existingTags: ["0.1.0"],
      });
      expect(p.build.some((t) => t.latest)).toBe(false);
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

  it("re-running 0.1.0 after 0.1.1 exists builds 0.1.0 but leaves latest on 0.1.1", () => {
    const p = planImages({
      ...base,
      version: "0.1.0",
      mode: "manual",
      tags: all("missing"),
      existingTags: ["0.1.0-rc.1", "0.1.1", "latest"],
    });
    expect(names(p)).toEqual(IMAGES.map((i) => i.image));
    expect(p.push).toBe(true);
    expect(latestOf(p)).toBe(false);
    // The GitHub release of a backport doesn't become the repository's latest release either.
    expect(p.latest).toBe(false);
  });

  it("a new highest version takes latest; no tags yet is eligible", () => {
    const tags = all("missing");
    const existingTags = ["0.1.0", "0.1.1", "latest", "sha256-abc.sig"];
    expect(latestOf(planImages({ ...base, mode: "manual", tags, existingTags }))).toBe(true);
    expect(planImages({ ...base, mode: "manual", tags, existingTags }).latest).toBe(true);
    expect(planImages({ ...base, version: "0.3.0-rc.1", mode: "manual", tags }).latest).toBe(false);
    expect(latestOf(planImages({ ...base, mode: "manual", tags, existingTags: [] }))).toBe(true);
    // A rebuild of the version that has latest keeps it.
    expect(
      latestOf(planImages({ ...base, mode: "manual", tags, existingTags: ["0.2.0", "latest"] })),
    ).toBe(true);
  });

  it("tags latest only for a non-prerelease version", () => {
    const tags = all("missing");
    expect(latestOf(planImages({ ...base, mode: "manual", tags }))).toBe(true);
    expect(latestOf(planImages({ ...base, version: "0.3.0-rc.1", mode: "manual", tags }))).toBe(
      false,
    );
  });
});

describe("compareSemver / takesLatest", () => {
  it.each([
    ["0.1.0", "0.1.1", -1],
    ["0.10.0", "0.9.9", 1],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-beta", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["2.0.0", "2.0.0", 0],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareSemver(a, b))).toBe(sign);
    expect(Math.sign(compareSemver(b, a))).toBe(sign === 0 ? 0 : -sign);
  });

  it("ignores tags that are not semvers and never gives latest to a prerelease", () => {
    expect(takesLatest("0.2.0", ["latest", "main", "0.1.9"])).toBe(true);
    expect(takesLatest("0.3.0-rc.2", [])).toBe(false);
  });

  it("prerelease tags don't count: latest tracks the highest stable version", () => {
    expect(takesLatest("0.2.0", ["0.1.0", "0.3.0-rc.1", "latest"])).toBe(true);
    expect(takesLatest("0.2.0", ["0.2.1", "0.3.0-rc.1"])).toBe(false);
  });
});

describe("listTags", () => {
  it("follows the Link header across pages", async () => {
    const urls: string[] = [];
    const f = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes("/token?")) return Response.json({ token: "t" });
      if (String(url).includes("last=0.1.1")) return Response.json({ tags: ["latest"] });
      return Response.json(
        { tags: ["0.1.0", "0.1.1"] },
        {
          headers: {
            link: '</v2/capybara-hq/capybara-api/tags/list?n=1000&last=0.1.1>; rel="next"',
          },
        },
      );
    }) as typeof fetch;
    expect(await listTags("capybara-api", { fetch: f })).toEqual(["0.1.0", "0.1.1", "latest"]);
    expect(urls[1]).toBe("https://ghcr.io/v2/capybara-hq/capybara-api/tags/list?n=1000");
    expect(urls[2]).toBe("https://ghcr.io/v2/capybara-hq/capybara-api/tags/list?n=1000&last=0.1.1");
  });

  it("a package the registry won't show has no tags; other errors throw", async () => {
    const denied = (async () =>
      Response.json({ errors: [] }, { status: 403 })) as unknown as typeof fetch;
    expect(await listTags("capybara-api", { fetch: denied })).toEqual([]);
    const broken = (async (url: string | URL) =>
      String(url).includes("/token?")
        ? Response.json({ token: "t" })
        : new Response(null, { status: 500 })) as typeof fetch;
    await expect(listTags("capybara-api", { fetch: broken })).rejects.toThrow(/500/);
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
