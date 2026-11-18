import { readFile, writeFile } from "node:fs/promises";
import {
  ConfigError,
  legacyPermissionEnvRenames,
  migratePermissionConfigText,
} from "@capybara-hq/kernel";

/** The streams `capybara config migrate-permissions` writes. */
export interface ConfigCommandIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * `capybara config migrate-permissions --in <file> --out <file>` (permission runtime cutover B1):
 * the bounded offline conversion of a config document to the new permission keys. It reads the
 * input, writes the converted document to a new output file (never over an existing one) and
 * names the old environment variables to rename. It connects to nothing: a Nacos data id is
 * converted from a saved copy and published through the reviewed config change, and the process
 * environment is the operator's to change before the restart. No value is printed.
 * Exit codes: 0 converted (or nothing to convert), 1 refused (conflict, invalid value, unreadable
 * input, existing output).
 */
export async function runConfigMigratePermissions(
  opts: { input: string; output: string },
  env: NodeJS.ProcessEnv,
  io: ConfigCommandIo,
): Promise<number> {
  try {
    const renames = legacyPermissionEnvRenames(env);
    let text: string;
    try {
      text = await readFile(opts.input, "utf8");
    } catch (e) {
      throw new ConfigError(
        `cannot read ${opts.input}: ${(e as NodeJS.ErrnoException).code ?? "unknown error"}`,
      );
    }
    const migration = migratePermissionConfigText(text);
    try {
      await writeFile(opts.output, migration.text, { flag: "wx" });
    } catch (e) {
      throw new ConfigError(
        `cannot write ${opts.output}: ${(e as NodeJS.ErrnoException).code ?? "unknown error"} (the output must be a new file)`,
      );
    }
    io.stdout.write(
      migration.changed.length === 0
        ? `No permission key to convert in ${opts.input}; wrote it unchanged to ${opts.output}\n`
        : `Converted ${opts.input} to ${opts.output}:\n${migration.changed.map((c) => `  ${c}\n`).join("")}`,
    );
    if (renames.length > 0)
      io.stdout.write(
        `Rename these environment variables before the restart (keep their values):\n${renames
          .map((r) => `  ${r.from} -> ${r.to}\n`)
          .join("")}`,
      );
    return 0;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.stderr.write(`capybara: ${e.message}\n`);
    return 1;
  }
}
