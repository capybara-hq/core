import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The release workflow's safety properties (P-16, C1). Breaking any of these could publish unreviewed
// versions, publish from a PR, or hand publish rights to the job that runs `changeset version`.
const file = fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url));
const text = readFileSync(file, "utf8");

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
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

  it("has exactly the version-pr and publish jobs", () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(["publish", "version-pr"]);
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

    it("gates pushes with --if-bumped-since the previous commit", () => {
      const run = job.steps.find((s) => s.run?.includes("pnpm release"));
      expect(run?.run).toContain('--if-bumped-since "$BEFORE"');
      expect(run?.env?.BEFORE).toBe("${{ github.event.before }}");
    });
  });

  it("pins every action to a commit SHA with a version comment", () => {
    const uses = text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses)
      expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});
