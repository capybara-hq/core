import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The release workflow's safety properties (P-16, C1). Breaking any of these could publish unreviewed
// versions, publish from a PR, or hand publish rights to the job that runs `changeset version`.
const file = fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url));
const text = readFileSync(file, "utf8");

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  "runs-on"?: string;
  strategy?: { matrix?: Record<string, unknown> };
  needs?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
const wf = parse(text) as {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<string, Job>;
};
const jobText = (j: Job) => JSON.stringify(j);

describe("release.yml", () => {
  it("runs on push to main and manual dispatch only, never on pull requests", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ branches: ["main"] });
    expect(wf.permissions).toEqual({});
  });

  it("has the version-pr and publish jobs, the three image jobs and the release tag", () => {
    expect(Object.keys(wf.jobs).sort()).toEqual([
      "images-build",
      "images-plan",
      "images-publish",
      "publish",
      "release-tag",
      "version-pr",
    ]);
  });

  describe("version-pr", () => {
    const job = wf.jobs["version-pr"] as Job;

    it("runs on push only and can write contents and PRs, nothing else", () => {
      expect(job.if).toContain("github.event_name == 'push'");
      expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    });

    it("runs changesets/action without a publish command and never touches npm", () => {
      const cs = job.steps.filter((s) => s.uses?.startsWith("changesets/action@"));
      expect(cs).toHaveLength(1);
      expect(cs[0]?.with?.publish).toBeUndefined();
      expect(jobText(job)).not.toMatch(
        /NPM_TOKEN|NODE_AUTH_TOKEN|id-token|pnpm release|npm publish/,
      );
    });

    it("versions with pnpm version-packages, which also syncs plugin versions, SDK_VERSION and its API report, the image tag and the bootstrap pins", () => {
      const cs = job.steps.find((s) => s.uses?.startsWith("changesets/action@"));
      expect(cs?.with?.version).toBe("pnpm version-packages");
      const pkg = JSON.parse(
        readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
      ) as { scripts: Record<string, string> };
      // Order matters: plugin.json / manifest versions first (the packer requires them equal to
      // package.json), then the bootstrap pins, whose packed bytes include those versions.
      expect(pkg.scripts["version-packages"]).toBe(
        "changeset version && pnpm sync:plugin-versions && pnpm sync:sdk-version && pnpm sync:image-tag && pnpm check:bootstrap --write",
      );
      // SDK_VERSION follows package.json (plugin-sdk's smoke test), then the API report that
      // records it is regenerated.
      expect(pkg.scripts["sync:sdk-version"]).toMatch(
        /tools\/checks\/src\/cli\/sync-sdk-version\.ts && pnpm gen:sdk-api$/,
      );
    });

    it("uses RELEASE_PR_TOKEN when set and logs a notice when it is not", () => {
      const cs = job.steps.find((s) => s.uses?.startsWith("changesets/action@"));
      expect(cs?.env?.GITHUB_TOKEN).toBe("${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}");
      expect(job.steps.some((s) => s.run?.includes("::notice::RELEASE_PR_TOKEN is not set"))).toBe(
        true,
      );
    });
  });

  describe("publish", () => {
    const job = wf.jobs.publish as Job;

    it("only reads contents and gets id-token", () => {
      expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    });

    it("shares nothing with version-pr: no needs, no artifact download, no changesets/action", () => {
      expect(job.needs).toBeUndefined();
      for (const s of job.steps) {
        expect(s.uses ?? "").not.toMatch(/^(changesets\/action|actions\/download-artifact)@/);
        expect(s.run ?? "").not.toMatch(/changeset version/);
      }
    });

    it("checks out exactly github.sha without persisted credentials", () => {
      const co = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
      expect(co).toHaveLength(1);
      expect(co[0]?.with?.ref).toBe("${{ github.sha }}");
      expect(co[0]?.with?.["persist-credentials"]).toBe(false);
    });

    it("builds every library, plugin-tools included, before publishing them", () => {
      const names = job.steps.map((s) => s.name);
      expect(names.indexOf("Build")).toBeGreaterThan(-1);
      expect(names.indexOf("Build")).toBeLessThan(names.indexOf("Publish to npm"));
      expect(job.steps.find((s) => s.name === "Build")?.run).toBe("pnpm build");
      // `pnpm build` is `tsc -b` of the root tsconfig.json: it must reach every published library.
      const refs = (
        JSON.parse(readFileSync(new URL("../../../tsconfig.json", import.meta.url), "utf8")) as {
          references: { path: string }[];
        }
      ).references.map((r) => r.path);
      expect(refs).toEqual(
        expect.arrayContaining([
          "packages/plugin-sdk",
          "packages/kernel",
          "packages/testing",
          "packages/plugin-tools",
        ]),
      );
    });

    it("checks bootstrap.json against npm and the marketplace (network mode) before publishing", () => {
      const names = job.steps.map((s) => s.name);
      const i = names.indexOf("Bootstrap manifest against npm and the marketplace");
      expect(i).toBeGreaterThan(-1);
      expect(i).toBeLessThan(names.indexOf("Publish to npm"));
      expect(job.steps[i]?.run).toBe("pnpm check:bootstrap --network");
      expect(job.steps[i]?.if).toBeUndefined();
    });

    it("publishes the libraries and model-fake only: every other plugin moves (A3b)", () => {
      const root = fileURLToPath(new URL("../../../package.json", import.meta.url));
      const scripts = (
        JSON.parse(readFileSync(root, "utf8")) as { scripts: Record<string, string> }
      ).scripts;
      expect(scripts.release).toMatch(/ release --root "\$OLDPWD" --plugins plugins\/model-fake$/);
      const run = job.steps.find((s) => s.run?.includes("pnpm release"));
      expect(run?.run).toMatch(/pnpm release "\$\{args\[@\]\}"/);
    });

    it("releases pushes with --auto (committed-tree guard, first release refused)", () => {
      const run = job.steps.find((s) => s.run?.includes("pnpm release"));
      expect(run?.run).toMatch(/if \[ "\$EVENT" = "push" \]; then\s+args\+=\(--auto\)/);
      // No comparison against the previous commit: a replaced (cancelled) run must not skip a release.
      expect(jobText(job)).not.toMatch(/github\.event\.before|if-bumped-since/);
    });
  });

  describe("images", () => {
    const plan = wf.jobs["images-plan"] as Job;
    const build = wf.jobs["images-build"] as Job;
    const publish = wf.jobs["images-publish"] as Job;
    const images = [plan, build, publish];

    it("follow a successful npm publish and run in order plan -> build -> publish", () => {
      expect(plan.needs).toBe("publish");
      expect(plan.if).toContain("github.repository == 'capybara-hq/core'");
      expect(build.needs).toBe("images-plan");
      expect(build.if).toBe("needs.images-plan.outputs.build == 'true'");
      expect(publish.needs).toEqual(["images-plan", "images-build"]);
      expect(publish.if).toBe("needs.images-plan.outputs.push == 'true'");
    });

    it("get only packages access: no npm token, no id-token, no contents write", () => {
      expect(plan.permissions).toEqual({ contents: "read", packages: "read" });
      expect(build.permissions).toEqual({ contents: "read", packages: "write" });
      expect(publish.permissions).toEqual({ packages: "write" });
      for (const j of images) expect(jobText(j)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|id-token/);
    });

    it("check out exactly github.sha without persisted credentials", () => {
      for (const j of [plan, build]) {
        const co = j.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
        expect(co).toHaveLength(1);
        expect(co[0]?.with?.ref).toBe(`\${{ github.sha }}`);
        expect(co[0]?.with?.["persist-credentials"]).toBe(false);
      }
    });

    it("plan: auto on push (first release refused), dry-run or manual on dispatch", () => {
      const run = plan.steps.find((s) => s.run?.includes("pnpm release:images"))?.run ?? "";
      expect(run).toMatch(/"\$EVENT" = "push" \]; then\s+mode=auto/);
      expect(run).toMatch(/"\$DRY_RUN" = "true" \]; then\s+mode=dry-run/);
      expect(run).toMatch(/else\s+mode=manual/);
    });

    it("build: each image on a native runner per architecture, by digest, with attestations", () => {
      expect(build.strategy?.matrix).toEqual({
        target: `\${{ fromJSON(needs.images-plan.outputs.matrix) }}`,
        arch: ["amd64", "arm64"],
      });
      expect(build["runs-on"]).toBe(
        `\${{ matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-24.04' }}`,
      );
      const b = build.steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
      expect(b?.with).toMatchObject({
        platforms: `linux/\${{ matrix.arch }}`,
        provenance: "mode=max",
        sbom: true,
      });
      expect(String(b?.with?.outputs)).toContain("push-by-digest=true");
      expect(String(b?.with?.outputs)).toContain(`push=\${{ needs.images-plan.outputs.push }}`);
      expect(String(b?.with?.labels)).toContain(
        "org.opencontainers.image.source=https://github.com/capybara-hq/core",
      );
      expect(String(b?.with?.["cache-to"])).toMatch(/^type=gha,mode=max,/);
    });

    it("build: nothing runs before the build that could change the checked-out tree", () => {
      const i = build.steps.findIndex((s) => s.uses?.startsWith("docker/build-push-action@"));
      expect(i).toBeGreaterThan(0);
      for (const s of build.steps.slice(0, i)) {
        expect(s.run).toBeUndefined();
        expect(s.uses ?? "").toMatch(
          /^(actions\/checkout|docker\/setup-buildx-action|docker\/login-action)@/,
        );
      }
      expect(jobText(build)).not.toMatch(/pnpm|npm install|setup-node/);
    });

    it("build: a re-run replaces its digest artifact", () => {
      const up = build.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
      expect(up?.with?.overwrite).toBe(true);
    });

    it("publish: tags latest only when the plan says so, the version tag last", () => {
      const step = publish.steps.find((s) => s.run?.includes("imagetools create"));
      // Per image: a denied tag lookup drops latest for that image only.
      expect(step?.env?.LATEST).toBe(`\${{ matrix.target.latest }}`);
      const run = step?.run ?? "";
      expect(run).toMatch(/if \[ "\$LATEST" = "true" \]; then\s+tags\+=\(--tag "\$IMAGE:latest"\)/);
      expect(run.indexOf(':latest"')).toBeLessThan(run.indexOf('tags+=(--tag "$IMAGE:$VERSION")'));
      expect(run).toContain(
        "index:org.opencontainers.image.source=https://github.com/capybara-hq/core",
      );
    });
  });

  describe("release-tag", () => {
    const job = wf.jobs["release-tag"] as Job;
    const run = job.steps.find((s) => s.run?.includes("gh release create"));

    it("runs only after the images of this run were pushed and tagged", () => {
      expect(job.needs).toEqual(["images-plan", "images-publish"]);
      expect(job.if).toBe("needs.images-plan.outputs.push == 'true'");
    });

    it("can only write contents: no packages, npm token or id-token, nothing checked out", () => {
      expect(job.permissions).toEqual({ contents: "write" });
      expect(jobText(job)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|id-token|actions\/checkout/);
    });

    it("tags exactly github.sha v<version>, idempotently", () => {
      expect(run?.env).toMatchObject({
        SHA: `\${{ github.sha }}`,
        VERSION: `\${{ needs.images-plan.outputs.version }}`,
        LATEST: `\${{ needs.images-plan.outputs.latest }}`,
      });
      const r = run?.run ?? "";
      expect(r).toContain('tag="v$VERSION"');
      expect(r).toMatch(/if gh release view "\$tag"[^\n]*; then\s+echo[^\n]*\s+exit 0/);
      expect(r).toContain('--target "$SHA"');
    });

    it("marks prereleases and versions below latest like the image latest rule", () => {
      const r = run?.run ?? "";
      expect(r).toContain("*-*) args+=(--prerelease)");
      expect(r).toMatch(/if \[ "\$LATEST" != "true" \]; then\s+args\+=\(--latest=false\)/);
    });
  });

  it("pins every action to a commit SHA with a version comment", () => {
    const uses = text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses)
      expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});

// The network half of check:bootstrap needs GitHub and npm: by diff on PRs (the plan's
// bootstrap-network output, true only when one of its inputs changed), always on main (planAll).
describe("ci.yml bootstrap network check", () => {
  const ci = parse(
    readFileSync(
      fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
      "utf8",
    ),
  ) as { jobs: Record<string, Job & { outputs?: Record<string, string> }> };

  it("runs in the ci job when the plan says so", () => {
    expect(ci.jobs.changes?.outputs?.["bootstrap-network"]).toBe(
      "${{ steps.plan.outputs.bootstrap-network }}",
    );
    const job = ci.jobs.ci as Job;
    expect(job.needs).toBe("changes");
    const step = job.steps.find((s) => s.run === "pnpm check:bootstrap --network");
    expect(step?.if).toBe("needs.changes.outputs.bootstrap-network == 'true'");
  });
});

// ci.yml's docker job builds the images on PRs: it must never reach a registry, and only pushes to
// main may write the shared layer cache (PR runs would evict it, or seed it from unreviewed code).
describe("ci.yml docker job", () => {
  const ciText = readFileSync(
    fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  const ci = parse(ciText) as { permissions: unknown; jobs: Record<string, Job> };
  const docker = ci.jobs.docker as Job;
  const builds = docker.steps.filter((s) => s.uses?.startsWith("docker/build-push-action@"));

  it("runs when the plan says so, feeds ci-ok and only reads contents", () => {
    expect(docker.if).toBe("needs.changes.outputs.docker == 'true'");
    expect(ci.jobs["ci-ok"]?.needs).toContain("docker");
    expect(ci.permissions).toEqual({});
    expect(docker.permissions).toEqual({ contents: "read" });
  });

  it("never logs in or pushes: four builds loaded into the local Docker", () => {
    expect(jobText(docker)).not.toMatch(/login-action|docker login|docker push|push-by-digest/);
    expect(builds).toHaveLength(4);
    for (const b of builds) {
      expect(b.with?.load).toBe(true);
      expect(b.with?.push).toBeUndefined();
      expect(b.with?.outputs).toBeUndefined();
      expect(b.with?.platforms).toBe("linux/amd64");
    }
  });

  it("writes the layer cache only on push", () => {
    expect(docker.env?.CACHE_TO).toBe(
      `\${{ github.event_name == 'push' && 'type=gha,mode=max' || '' }}`,
    );
    for (const b of builds) {
      const to = b.with?.["cache-to"];
      if (to !== undefined) expect(String(to)).toMatch(/^\$\{\{ env\.CACHE_TO != '' && /);
    }
    expect(builds.filter((b) => b.with?.["cache-to"] !== undefined).length).toBeGreaterThan(0);
  });

  it("pins its actions to commit SHAs", () => {
    for (const s of docker.steps.filter((x) => x.uses !== undefined)) {
      expect(s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const lines = ciText.slice(ciText.indexOf("\n  docker:\n"), ciText.indexOf("\n  # Aggregate"));
    for (const l of lines.split("\n").filter((x) => /^\s*-?\s*uses:/.test(x))) {
      expect(l).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it("runs the compose smoke test against the loaded images", () => {
    const smoke = docker.steps.at(-1);
    expect(smoke?.run).toBe("docker/test/compose-smoke.sh");
    expect(smoke?.env?.SKIP_BUILD).toBe("1");
  });
});

// While the first release is a release candidate (A3b amendment), changesets run in pre mode, so a
// changeset versions 0.1.0-rc.0 to 0.1.0-rc.1, never to 0.1.0. The promotion PR runs
// `changeset pre exit` (mode "exit"); `changeset version` then deletes pre.json and this case with it.
describe("changesets pre mode", () => {
  it("is on with the tag rc while the kernel is a prerelease", () => {
    const read = (rel: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8"));
    const kernel = read("packages/kernel/package.json") as { version: string };
    if (!kernel.version.includes("-")) return;
    // "exit": the promotion PR has run `changeset pre exit`; the next `changeset version` promotes.
    const pre = read(".changeset/pre.json") as { mode: string; tag: string };
    expect(pre.tag).toBe("rc");
    expect(["pre", "exit"]).toContain(pre.mode);
  });
});
