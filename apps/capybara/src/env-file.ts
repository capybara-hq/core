import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { UsageError } from "./args.js";

/** The env file `capybara` loads when none is named: `.env` in the working directory. */
export const DEFAULT_ENV_FILE = ".env";

/**
 * Takes the global `--env-file <path>` / `--env-file=<path>` / `--no-env-file` options out of the
 * arguments (they may appear anywhere, before or after the command). `file` is the file to load,
 * or `null` when loading is turned off; `undefined` means the default (`.env` when present).
 */
export function takeEnvFileOption(argv: string[]): { argv: string[]; file?: string | null } {
  const rest: string[] = [];
  let file: string | null | undefined;
  const set = (value: string | null) => {
    if (file !== undefined) throw new UsageError("--env-file / --no-env-file given more than once");
    file = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--no-env-file") set(null);
    else if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      const value = arg === "--env-file" ? argv[++i] : arg.slice("--env-file=".length);
      if (value === undefined || value.trim() === "")
        throw new UsageError("--env-file needs a path");
      set(value);
    } else rest.push(arg);
  }
  return file === undefined ? { argv: rest } : { argv: rest, file };
}

/**
 * Loads the env file into `process.env` with Node's own parser (`process.loadEnvFile`). Variables
 * already set in the environment win over the file. A file named with `--env-file` must exist; the
 * default `.env` is loaded only when present. Returns the absolute path loaded, if any.
 */
export function loadEnvFile(
  file: string | null | undefined,
  cwd: string,
  load: (path: string) => void = process.loadEnvFile,
): string | undefined {
  if (file === null) return undefined;
  const path = resolve(cwd, file ?? DEFAULT_ENV_FILE);
  if (!existsSync(path)) {
    if (file === undefined) return undefined;
    throw new UsageError(`env file not found: ${file}`);
  }
  load(path);
  return path;
}
