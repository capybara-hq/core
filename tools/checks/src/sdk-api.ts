import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "./source.js";

const run = promisify(execFile);

/** The repo's `packages/plugin-sdk`. */
export const DEFAULT_SDK_DIR = fileURLToPath(
  new URL("../../../packages/plugin-sdk", import.meta.url),
);

/** The API report, relative to the SDK directory. */
export const SDK_API_REPORT_FILE = "api/plugin-sdk.api.md";

/** TypeScript 7's `tsc` (emits the declarations api-extractor reads). */
const TSC = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));

/**
 * Generates the SDK's public API report with api-extractor and compares it with the committed
 * `api/plugin-sdk.api.md` (`update: true` writes it instead).
 *
 * The declarations are emitted from `src` into a temp directory (`<sdkDir>/.sdk-api-tmp-*`) first, so a stale `dist` never
 * hides a change; api-extractor (using its bundled TypeScript) then reads only those `.d.ts`
 * files, with the settings of `<sdkDir>/api-extractor.json` and the paths pointed at the temp
 * directory. The report drops implementation details and doc comments, and `normalizeReport`
 * drops the `(undocumented)` markers, so comment-only edits don't change it.
 */
export async function checkSdkApi(opts: { update: boolean; sdkDir?: string }): Promise<Finding[]> {
  const sdkDir = opts.sdkDir ?? DEFAULT_SDK_DIR;
  const reportFile = join(sdkDir, SDK_API_REPORT_FILE);
  // Inside the SDK directory so api-extractor finds the SDK's package.json and node_modules.
  const tmp = await mkdtemp(join(sdkDir, ".sdk-api-tmp-"));
  try {
    const dts = join(tmp, "dts");
    await exec(TSC, [
      "-p",
      join(sdkDir, "tsconfig.json"),
      "--outDir",
      dts,
      "--emitDeclarationOnly",
      "--declaration",
      "--composite",
      "false",
      "--incremental",
      "false",
    ]);

    const base = JSON.parse(await readFile(join(sdkDir, "api-extractor.json"), "utf8"));
    const entry = join(dts, "index.d.ts");
    const config = {
      ...base,
      projectFolder: sdkDir,
      mainEntryPointFilePath: entry,
      compiler: {
        ...base.compiler,
        overrideTsconfig: { ...base.compiler?.overrideTsconfig, files: [entry] },
      },
      apiReport: {
        ...base.apiReport,
        enabled: true,
        reportFolder: join(tmp, "report"),
        reportTempFolder: join(tmp, "report-temp"),
      },
    };
    const configFile = join(tmp, "api-extractor.json");
    await writeFile(configFile, JSON.stringify(config, null, 2));
    await mkdir(join(tmp, "report"));
    await exec(join(sdkDir, "node_modules/.bin/api-extractor"), [
      "run",
      "--local",
      "--config",
      configFile,
    ]);
    const generated = normalizeReport(
      await readFile(join(tmp, "report", base.apiReport.reportFileName), "utf8"),
    );

    if (opts.update) {
      await mkdir(dirname(reportFile), { recursive: true });
      await writeFile(reportFile, generated);
      return [];
    }
    const committed = existsSync(reportFile) ? await readFile(reportFile, "utf8") : undefined;
    if (committed === generated) return [];
    return [
      {
        file: reportFile,
        line: 1,
        rule: "sdk-api-stale",
        message:
          committed === undefined
            ? "the plugin SDK API report is missing; run pnpm gen:sdk-api and commit it"
            : "the plugin SDK public API differs from the committed report; run pnpm gen:sdk-api, " +
              "commit the report and add a changeset for @capybara-hq/plugin-sdk",
      },
    ];
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * api-extractor marks items without a doc comment `(undocumented)`; drop the marker so adding or
 * removing a doc comment doesn't count as an API change.
 */
export function normalizeReport(report: string): string {
  return report
    .replace(/^[ \t]*\/\/ \(undocumented\)\r?\n/gm, "")
    .replace(/ \(undocumented\)$/gm, "");
}

async function exec(file: string, args: string[]): Promise<void> {
  try {
    await run(file, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${file} ${args.join(" ")} failed: ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`,
    );
  }
}
