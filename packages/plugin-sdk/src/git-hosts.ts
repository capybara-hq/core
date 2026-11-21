import { z } from "zod";
import { validateAllowHost } from "./device-provider.js";

/**
 * The git source of a connector: the git hosts a connector's credential may be used for, and the
 * HTTP basic username to present for each (spec 2026-11-12-sandbox-git-credentials §6.1). Pure
 * validation; the kernel reuses {@link GitSourceSchema} for its connector create body.
 */

/** Limits of {@link GitSourceSchema}. */
export const GIT_HOSTS_LIMITS = {
  /** Hosts per connector. */
  hosts: 8,
  /** Characters of a username. */
  usernameChars: 64,
} as const;

/**
 * The basic-auth usernames of well-known git hosts: a GitHub token (a PAT or an app installation
 * token) is presented with the fixed username `x-access-token`. Documentation for template authors;
 * a connector still states its username explicitly.
 */
export const GIT_HOST_USERNAMES = {
  "github.com": "x-access-token",
  "*.ghe.com": "x-access-token",
} as const;

/** A valid HTTP basic username: `^[A-Za-z0-9._-]{1,64}$`. */
export const GIT_USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The username a git marketplace credential is presented with when none is stored. */
export const GIT_MARKETPLACE_USERNAME_DEFAULT = "x-access-token";

/**
 * A hint for forms: the basic username well-known git hosts document for a token. Other hosts
 * return `undefined`; the user enters the username the host's documentation names.
 */
export function suggestGitUsername(host: string): string | undefined {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".ghe.com")) return GIT_MARKETPLACE_USERNAME_DEFAULT;
  if (h === "bitbucket.org") return "x-token-auth";
  if (h === "gitlab.com") return "oauth2";
  return undefined;
}

/** One git host and the username its credential is presented with. */
export interface GitHostEntry {
  /** Lower-case hostname with no scheme, port, path, wildcard or userinfo. */
  host: string;
  /** HTTP basic username, `^[A-Za-z0-9._-]{1,64}$`. */
  username: string;
}

/** The git source of a connector (`git` on a connector template and on a custom connector). */
export interface GitSource {
  hosts: GitHostEntry[];
}

/** Why a host is refused; never echoes the value (it may be a pasted credential or URL). */
function hostProblems(h: string): string[] {
  if (/[@:/?#\s]/.test(h)) return ["host must be a bare hostname (no userinfo, port or path)"];
  if (h.includes("*")) return ["host must not contain a wildcard"];
  if (h !== h.toLowerCase()) return ["host must be lower-case"];
  return validateAllowHost(h);
}

const GitHostEntrySchema = z.strictObject({
  host: z
    .string()
    .max(253, "host must be at most 253 characters")
    .superRefine((h, ctx) => {
      for (const message of hostProblems(h)) ctx.addIssue({ code: "custom", message });
    }),
  username: z
    .string()
    .regex(
      GIT_USERNAME_RE,
      "username must match ^[A-Za-z0-9._-]{1,64}$ (letters, digits, '.', '_', '-')",
    ),
});

/**
 * The zod schema of {@link GitSource} (strict objects, 1 to {@link GIT_HOSTS_LIMITS}`.hosts` hosts,
 * no duplicate host). Error messages never echo the offending value.
 */
export const GitSourceSchema: z.ZodType<GitSource> = z
  .strictObject({
    hosts: z
      .array(GitHostEntrySchema)
      .min(1, "hosts must not be empty")
      .max(GIT_HOSTS_LIMITS.hosts),
  })
  .superRefine((g, ctx) => {
    const seen = new Set<string>();
    g.hosts.forEach((e, i) => {
      if (seen.has(e.host)) {
        ctx.addIssue({ code: "custom", path: ["hosts", i, "host"], message: "duplicate host" });
      }
      seen.add(e.host);
    });
  }) as unknown as z.ZodType<GitSource>;

/** Validates a `git` value; returns problems as `<path>: <message>` (empty means valid). */
export function validateGitSource(git: unknown, at = "git"): string[] {
  const r = GitSourceSchema.safeParse(git);
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const path = i.path.map(String).join(".");
    return `${path === "" ? at : `${at}.${path}`}: ${i.message}`;
  });
}

/** Parses a `git` value: the value, or `{ errors }`. */
export function parseGitSource(git: unknown): GitSource | { errors: string[] } {
  const errors = validateGitSource(git);
  return errors.length > 0 ? { errors } : (GitSourceSchema.parse(git) as GitSource);
}
