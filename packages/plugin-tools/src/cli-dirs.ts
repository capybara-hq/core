/**
 * Where a command resolves paths. Paths given on the command line resolve against `invoked` (the
 * directory the user ran it from: `INIT_CWD` under a package manager script, else the current
 * directory); defaults (the repository root, output directories) live under `cwd` (the current
 * directory of the process: the package root under a package manager script).
 */
export interface CommandDirs {
  invoked: string;
  cwd: string;
}

/** The {@link CommandDirs} of this process. */
export const processDirs = (): CommandDirs => ({
  invoked: process.env.INIT_CWD ?? process.cwd(),
  cwd: process.cwd(),
});
