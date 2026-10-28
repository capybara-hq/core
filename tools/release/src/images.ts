/**
 * Planning for the image release (`.github/workflows/release.yml`, images jobs): which of the four
 * images get built and whether they are pushed to ghcr.io. The tag is the version of `apps/capybara`
 * (changesets versions private packages for this reason).
 *
 * Modes:
 * - `auto` (push to main): nothing before the first npm release (P-16: the first release, npm and
 *   images, is a manual workflow run); afterwards every image whose version tag is not in the registry
 *   yet. Like the npm publish (R8) there is no "did this push bump the version" check, so a run that
 *   replaced a cancelled one, or a run after a failed one, still publishes what is missing.
 * - `manual` (workflow_dispatch): every image whose version tag is missing. A package that does not
 *   exist yet answers like a private one ("denied"), so here that counts as missing.
 * - `dry-run`: build every image, push nothing.
 *
 * Bootstrap gate (A3b): while `packages/kernel/bootstrap.json` has a `"source": "workspace"` entry,
 * `auto` and `manual` plan nothing. An image bakes the bootstrap plugins, and a released image must
 * carry the npm-published packages its pins name (provenance from capybara-hq/plugins), never a
 * pack of this tree's plugin sources. A dry run still builds.
 *
 * Also irreversible, so also gated (not in a dry run): a stable version never bakes a prerelease
 * npm pin (an rc image with stable pins is fine), and in `auto` a stable version whose highest image
 * tag is a prerelease of it (0.1.0 after 0.1.0-rc.1) plans nothing: promoting a release candidate is
 * a manual run, like the first release and like the npm side (`capybara-plugin release --auto`).
 */

import {
  compareSemver,
  isPrerelease,
  isPromotion,
  parseSemver,
  SEMVER_RE,
} from "@capybara-hq/plugin-tools/release";

export const REGISTRY = "ghcr.io";
export const NAMESPACE = "capybara-hq";

export interface ImageTarget {
  /** Package name under ghcr.io/capybara-hq. */
  image: string;
  dockerfile: string;
  /** `ROLES` build argument of docker/kernel.Dockerfile; empty for the web image. */
  roles: string;
  /** Layer cache scope (per architecture): the three kernel images share their build stage. */
  cache: string;
}

export const IMAGES: readonly ImageTarget[] = [
  { image: "capybara-api", dockerfile: "docker/kernel.Dockerfile", roles: "api", cache: "kernel" },
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
];

export const imageRef = (image: string) => `${REGISTRY}/${NAMESPACE}/${image}`;

export { compareSemver, isPrerelease };

/**
 * Whether `version` may take `latest`: no prerelease part, and not lower than any stable semver tag
 * already in the registry (so re-running an old release never moves `latest` back). Prerelease tags
 * don't count: `latest` tracks the highest stable version. No tags yet = eligible.
 */
export function takesLatest(version: string, existingTags: readonly string[]): boolean {
  if (isPrerelease(version)) return false;
  return existingTags.every(
    (t) => parseSemver(t) === undefined || isPrerelease(t) || compareSemver(version, t) >= 0,
  );
}

/** Whether an image has a tag: `denied` = the registry won't say (no such package, or no access). */
export type TagState = "present" | "missing" | "denied";

export type ImageMode = "auto" | "manual" | "dry-run";

export interface PlanImagesInput {
  mode: ImageMode;
  /** The version of apps/capybara in this run's own tree: the only tag a run ever builds. */
  version: string;
  /** Some public workspace package is on npm, i.e. the first (manual) release has happened. */
  npmReleased: boolean;
  /** Image name -> state of its `version` tag. Not needed for `dry-run`. */
  tags: Readonly<Record<string, TagState>>;
  /** Every tag the image packages already have (all four together); `latest` never moves back. */
  existingTags?: readonly string[];
  /**
   * npm shows no version of any public package other than the one in this run's tree (the first
   * release is this run's own). Unset = false.
   */
  npmOnlyTreeVersions?: boolean;
  /**
   * Names of the `"source": "workspace"` entries of `packages/kernel/bootstrap.json`; any closes the
   * gate for `auto` and `manual`. Unset = no gate (callers that read the manifest always set it).
   */
  workspaceBootstrap?: readonly string[];
  /** `name@version` of the `"source": "npm"` bootstrap pins that are prereleases. Unset = none. */
  prereleasePins?: readonly string[];
}

/** An image to build, and whether its multi-arch tag set includes `latest`. */
export interface PlannedImage extends ImageTarget {
  latest: boolean;
}

export interface ImagePlan {
  version: string;
  /** Push to ghcr.io (false: build only, or nothing to do). */
  push: boolean;
  /**
   * `version` takes `latest` (no prerelease part, not below any stable tag). The git tag job uses it
   * to decide whether the GitHub release becomes the repository's latest release.
   */
  latest: boolean;
  build: PlannedImage[];
  reason: string;
}

export function planImages(input: PlanImagesInput): ImagePlan {
  const { mode, version } = input;
  if (!SEMVER_RE.test(version)) {
    throw new Error(`apps/capybara version "${version}" is not a semver usable as an image tag`);
  }
  const latest = takesLatest(version, input.existingTags ?? []);
  if (mode === "dry-run") {
    const build = IMAGES.map((t) => ({ ...t, latest }));
    return { version, push: false, latest, build, reason: "dry run: build only" };
  }
  const workspace = input.workspaceBootstrap ?? [];
  if (workspace.length > 0) {
    return {
      version,
      push: false,
      latest,
      build: [],
      reason:
        "bootstrap.json has workspace entries: images are released only with npm-pinned " +
        `bootstrap plugins (${workspace.join(", ")})`,
    };
  }
  const rcPins = input.prereleasePins ?? [];
  if (!isPrerelease(version) && rcPins.length > 0) {
    return {
      version,
      push: false,
      latest,
      build: [],
      reason:
        `a stable image (${version}) must bake stable bootstrap plugins; bootstrap.json pins ` +
        `prereleases: ${rcPins.join(", ")}`,
    };
  }
  if (mode === "auto" && isPromotion(version, input.existingTags ?? [])) {
    const semvers = (input.existingTags ?? []).filter((t) => SEMVER_RE.test(t));
    const from = semvers.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
    return {
      version,
      push: false,
      latest,
      build: [],
      reason:
        `promoting ${version} from ${from}: images are promoted only by a manual run of the ` +
        "release workflow (workflow_dispatch)",
    };
  }
  if (mode === "auto" && !input.npmReleased) {
    return {
      version,
      push: false,
      latest,
      build: [],
      reason:
        "nothing is on npm yet: the first release (npm and images) is published only by running " +
        "the release workflow manually (workflow_dispatch)",
    };
  }
  // No image package exists at all: every lookup is denied (ghcr.io answers "denied" for a package
  // that doesn't exist) and the registry shows no tag anywhere. That is the first image release, even
  // though npm already shows the version: the `publish` job of the same manual run published it before
  // `images-plan` looked. A denied lookup also hides the tags of packages that do exist (private
  // packages, a token problem), so npm must show nothing but this tree's versions too: otherwise this
  // is a re-run of an older release, and `latest` would move back.
  const firstImageRelease =
    input.npmOnlyTreeVersions === true &&
    IMAGES.every((t) => input.tags[t.image] === "denied") &&
    (input.existingTags ?? []).length === 0;
  const build: PlannedImage[] = [];
  for (const target of IMAGES) {
    const state = input.tags[target.image];
    if (state === undefined) throw new Error(`no tag state for ${target.image}`);
    if (state === "present") continue;
    if (state === "denied" && mode === "auto") {
      throw new Error(
        `${imageRef(target.image)}: the registry denied the lookup of tag ${version}. After the ` +
          "first release every image package must exist, be public and grant this repository " +
          "access; publish a new image with a manual run of the release workflow",
      );
    }
    // A denied lookup hid this package's tags, so `latest` might move back. Only on the first
    // release (nothing on npm yet, or no image package at all) is "denied" expected to mean "the
    // package doesn't exist yet".
    const imageLatest = latest && (state !== "denied" || !input.npmReleased || firstImageRelease);
    build.push({ ...target, latest: imageLatest });
  }
  const reason =
    build.length === 0
      ? `every image already has tag ${version}`
      : `missing tag ${version}: ${build.map((t) => t.image).join(", ")}`;
  return { version, push: build.length > 0, latest, build, reason };
}

/** Follows a registry `Link: <...>; rel="next"` header (relative to the registry). */
function nextLink(res: Response): string | undefined {
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(res.headers.get("link") ?? "");
  return m?.[1] === undefined ? undefined : new URL(m[1], `https://${REGISTRY}`).toString();
}

async function pullToken(repo: string, opts: TagStateOptions): Promise<string | "denied"> {
  const f = opts.fetch ?? fetch;
  const tokenUrl = new URL(`https://${REGISTRY}/token`);
  tokenUrl.searchParams.set("service", REGISTRY);
  tokenUrl.searchParams.set("scope", `repository:${repo}:pull`);
  const headers: Record<string, string> = {};
  if (opts.githubToken !== undefined && opts.githubToken !== "") {
    const basic = Buffer.from(`x-access-token:${opts.githubToken}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }
  const tokenRes = await f(tokenUrl.toString(), { headers });
  if (tokenRes.status === 401 || tokenRes.status === 403) return "denied";
  if (!tokenRes.ok) throw new Error(`${REGISTRY} token for ${repo}: HTTP ${tokenRes.status}`);
  const body = (await tokenRes.json()) as { token?: unknown };
  if (typeof body.token !== "string") throw new Error(`${REGISTRY} token for ${repo}: no token`);
  return body.token;
}

/**
 * Every tag of `ghcr.io/capybara-hq/<image>` (paginated). A package the registry won't show (it does
 * not exist yet, or we may not read it) has no tags as far as `latest` is concerned.
 */
export async function listTags(image: string, opts: TagStateOptions = {}): Promise<string[]> {
  const f = opts.fetch ?? fetch;
  const repo = `${NAMESPACE}/${image}`;
  const token = await pullToken(repo, opts);
  if (token === "denied") return [];
  const tags: string[] = [];
  let url: string | undefined = `https://${REGISTRY}/v2/${repo}/tags/list?n=1000`;
  for (let page = 0; url !== undefined; page++) {
    if (page >= 100) throw new Error(`${imageRef(image)}: too many tag pages`);
    const res = await f(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403 || res.status === 404) return [];
    if (!res.ok) throw new Error(`${imageRef(image)} tags: HTTP ${res.status}`);
    const body = (await res.json()) as { tags?: unknown };
    if (Array.isArray(body.tags))
      for (const t of body.tags) if (typeof t === "string") tags.push(t);
    url = nextLink(res);
  }
  return tags;
}

/** Media types a tag may point at: multi-arch indexes (what we push) and single manifests. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface TagStateOptions {
  fetch?: typeof fetch;
  /** GITHUB_TOKEN (packages: read) for packages that are not public; anonymous when absent. */
  githubToken?: string | undefined;
}

/**
 * Whether `ghcr.io/capybara-hq/<image>:<tag>` exists, through the registry API: a pull token from
 * ghcr.io/token, then HEAD on the manifest. 401 / 403 = `denied` (ghcr.io answers that for a package
 * that does not exist as well as for one we may not read). Any other unexpected status throws, so an
 * outage never reads as "missing".
 */
export async function tagState(
  image: string,
  tag: string,
  opts: TagStateOptions = {},
): Promise<TagState> {
  const f = opts.fetch ?? fetch;
  const repo = `${NAMESPACE}/${image}`;
  const token = await pullToken(repo, opts);
  if (token === "denied") return "denied";
  const res = await f(`https://${REGISTRY}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
  });
  if (res.status === 200) return "present";
  if (res.status === 404) return "missing";
  if (res.status === 401 || res.status === 403) return "denied";
  throw new Error(`${imageRef(image)}:${tag}: HTTP ${res.status}`);
}
