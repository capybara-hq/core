import { readFile } from "node:fs/promises";
import {
  type BootstrapEntry,
  type BootstrapExtraManifest,
  type BootstrapExtraMarketplace,
  type BootstrapGitEntry,
  type BootstrapManifest,
  type Logger,
  parseBootstrapExtraManifest,
} from "@capybara-hq/plugin-sdk";
import { marketplaceForm } from "../catalog/marketplaces.service.js";
import { ApiError } from "../errors.js";
import { BOOTSTRAP_MANIFEST_FILE, errMsg, readBootstrapManifest } from "./bootstrap.js";

/**
 * The built-in bootstrap manifest merged with the extra one (spec 2026-11-20-bootstrap-extra-manifest
 * §3): ONE manifest, built-in entries first, hashed as a whole by `bootstrapManifestSha256`. `extra`
 * is absent without an extra manifest, so the object (and its sha256) is the built-in manifest's.
 */
export type MergedBootstrapManifest = Omit<BootstrapManifest, "plugins"> & {
  plugins: MergedBootstrapEntry[];
  extra?: {
    marketplaces: BootstrapExtraMarketplace[];
    defaultTheme?: { plugin: string; theme: string };
  };
};

/** A git entry of the merged manifest: `required` defaults to false, as for an npm extra entry. */
export type BootstrapGitRunEntry = BootstrapGitEntry & { required: boolean };

/** One entry of the merged manifest. */
export type MergedBootstrapEntry = BootstrapEntry | BootstrapGitRunEntry;

/** What the bootstrap step runs: the merged manifest. */
export type LoadedBootstrapManifest = MergedBootstrapManifest;

/** Reads and parses an extra manifest; every problem (also a missing file) is `bootstrap.extra_invalid`. */
export async function readBootstrapExtraManifest(file: string): Promise<BootstrapExtraManifest> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new ApiError(
      "bootstrap.extra_invalid",
      `Cannot read the extra bootstrap manifest ${file}: ${errMsg(e)}`,
    );
  }
  const parsed = parseBootstrapExtraManifest(json);
  if ("errors" in parsed) {
    throw new ApiError(
      "bootstrap.extra_invalid",
      `Invalid extra bootstrap manifest ${file}: ${parsed.errors.join("; ")}`,
    );
  }
  checkGitMarketplaces(parsed.manifest, file);
  return parsed.manifest;
}

/** A git entry reads its marketplace as a git repository, so that marketplace must be git form. */
function checkGitMarketplaces(extra: BootstrapExtraManifest, where: string): void {
  const used = new Set(extra.plugins.flatMap((e) => (e.source === "git" ? [e.marketplace] : [])));
  for (const m of extra.marketplaces) {
    if (used.has(m.name) && marketplaceForm(m.url).form !== "git") {
      throw new ApiError(
        "bootstrap.extra_invalid",
        `Invalid extra bootstrap manifest ${where}: marketplace ${m.name} serves git entries, so its url must be a git repository: an https URL ending in .git`,
      );
    }
  }
}

/** Built-in entries first, then the extra ones; a name in both is `bootstrap.extra_conflict`. */
export function mergeBootstrapManifests(
  builtin: BootstrapManifest,
  extra: BootstrapExtraManifest | undefined,
): MergedBootstrapManifest {
  if (extra === undefined) return builtin;
  checkGitMarketplaces(extra, "(extra manifest)");
  const names = new Set(builtin.plugins.map((p) => p.name));
  for (const e of extra.plugins) {
    if (names.has(e.name)) {
      throw new ApiError(
        "bootstrap.extra_conflict",
        `The extra bootstrap manifest declares plugin ${e.name}, which the built-in bootstrap manifest already pins; an extra manifest never overrides a built-in pin`,
      );
    }
  }
  const plugins: MergedBootstrapEntry[] = [
    ...builtin.plugins,
    ...extra.plugins.map((e) =>
      e.source === "git"
        ? { ...e, required: e.required ?? false }
        : ({ ...e, required: e.required ?? false } as BootstrapEntry),
    ),
  ];
  return {
    ...builtin,
    plugins,
    extra: {
      marketplaces: extra.marketplaces,
      ...(extra.defaultTheme !== undefined && { defaultTheme: extra.defaultTheme }),
    },
  };
}

/** Loads the built-in manifest (a given one, else the file) and merges the extra file into it. */
export async function loadBootstrapManifest(o: {
  manifestFile?: string;
  builtin?: BootstrapManifest;
  extraManifest?: string;
}): Promise<LoadedBootstrapManifest> {
  const builtin =
    o.builtin ?? (await readBootstrapManifest(o.manifestFile ?? BOOTSTRAP_MANIFEST_FILE));
  const extra =
    o.extraManifest !== undefined ? await readBootstrapExtraManifest(o.extraManifest) : undefined;
  return mergeBootstrapManifests(builtin, extra);
}

/**
 * A process without an extra manifest found config-managed marketplaces (`names`): another
 * service of the deployment runs with an extra manifest. Bootstrapping or syncing here would
 * demote those marketplaces and strip the extra entries' `required` / `builtin` under the
 * built-in manifest's sha, which the correctly configured services then take as done.
 */
export function missingExtraManifestMessage(names: readonly string[]): string {
  return `this service has no extra bootstrap manifest (bootstrap.extraManifest, env CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST), but the deployment has marketplaces an extra manifest manages (${names.join(", ")}): every service (init, api, worker, gateway) must use the same extra manifest. To remove a distribution, point bootstrap.extraManifest at a file whose marketplaces and plugins lists are empty`;
}

/** Postgres deadlock_detected / serialization_failure: replicas starting together may collide. */
const isContention = (e: unknown): boolean => {
  const codeOf = (x: unknown) => (x as { code?: unknown } | null)?.code;
  const code = codeOf(e) ?? codeOf((e as { cause?: unknown } | null)?.cause);
  return code === "40P01" || code === "40001";
};

/**
 * Runs `syncExtraFromConfig`: a deadlock or serialization failure is retried once; a failure that
 * remains is logged and does not stop the start (another replica writes the same rows).
 * A configuration error is not contention and is thrown. The marketplaces it demoted (their
 * names left the extra manifest) are logged as a warning.
 */
export async function syncExtraMarketplaces(
  sync: (marketplaces: readonly BootstrapExtraMarketplace[]) => Promise<readonly string[]>,
  marketplaces: readonly BootstrapExtraMarketplace[],
  log: Pick<Logger, "warn">,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const demoted = await sync(marketplaces);
      if (demoted.length > 0) {
        log.warn(
          "marketplaces left the extra bootstrap manifest: they are now ordinary custom marketplaces (editable, no deployment token)",
          { marketplaces: demoted },
        );
      }
      return;
    } catch (e) {
      if (!isContention(e)) throw e;
      if (attempt < 2) continue;
      log.warn("could not sync the marketplaces of the extra bootstrap manifest; continuing", {
        error: errMsg(e),
      });
      return;
    }
  }
}
