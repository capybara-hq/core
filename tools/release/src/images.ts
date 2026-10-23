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
 */

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

/** A plain semver that is also a valid image tag (no `+build` metadata: `+` is not allowed in tags). */
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z-]+)*)?$/;

export const isPrerelease = (version: string) => version.includes("-");

/** Whether an image has a tag: `denied` = the registry won't say (no such package, or no access). */
export type TagState = "present" | "missing" | "denied";

export type ImageMode = "auto" | "manual" | "dry-run";

export interface PlanImagesInput {
  mode: ImageMode;
  version: string;
  /** Some public workspace package is on npm, i.e. the first (manual) release has happened. */
  npmReleased: boolean;
  /** Image name -> state of its `version` tag. Not needed for `dry-run`. */
  tags: Readonly<Record<string, TagState>>;
}

export interface ImagePlan {
  version: string;
  /** Push to ghcr.io (false: build only, or nothing to do). */
  push: boolean;
  /** Also tag `latest` (only for a version without a prerelease part). */
  latest: boolean;
  build: ImageTarget[];
  reason: string;
}

export function planImages(input: PlanImagesInput): ImagePlan {
  const { mode, version } = input;
  if (!VERSION_RE.test(version)) {
    throw new Error(`apps/capybara version "${version}" is not a semver usable as an image tag`);
  }
  const latest = !isPrerelease(version);
  if (mode === "dry-run") {
    return { version, push: false, latest, build: [...IMAGES], reason: "dry run: build only" };
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
  const build: ImageTarget[] = [];
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
    build.push(target);
  }
  const reason =
    build.length === 0
      ? `every image already has tag ${version}`
      : `missing tag ${version}: ${build.map((t) => t.image).join(", ")}`;
  return { version, push: build.length > 0, latest, build, reason };
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

  const res = await f(`https://${REGISTRY}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${body.token}`, accept: MANIFEST_ACCEPT },
  });
  if (res.status === 200) return "present";
  if (res.status === 404) return "missing";
  if (res.status === 401 || res.status === 403) return "denied";
  throw new Error(`${imageRef(image)}:${tag}: HTTP ${res.status}`);
}
