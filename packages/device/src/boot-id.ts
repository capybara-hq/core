import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeviceBootId } from "@capybara-hq/plugin-sdk";

/** What reading the boot identity needs (injected in tests). */
export interface BootIdSources {
  platform: NodeJS.Platform;
  /** Reads a file as text (Linux). */
  readFile(path: string): string;
  /** Runs `sysctl -n <name>` and returns its output (macOS). */
  sysctl(name: string): string;
}

const realSources: BootIdSources = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  sysctl: (name) =>
    execFileSync("/usr/sbin/sysctl", ["-n", name], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
};

/**
 * The `kern.boottime` value as a boot identity: `{ sec = 1700000000, usec = 123456 } …` becomes
 * `boottime-1700000000.123456`. Undefined when it does not read as that.
 */
export function bootTimeId(raw: string): string | undefined {
  const m = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(raw);
  return m ? `boottime-${m[1]}.${m[2]}` : undefined;
}

const attempt = (read: () => string): string | undefined => {
  try {
    return read().trim();
  } catch {
    return undefined;
  }
};

/**
 * The identity of the host's current OS boot, reported in the hello (`bootId`): Linux
 * `/proc/sys/kernel/random/boot_id`; macOS `kern.bootsessionuuid`, else `kern.boottime`. A value
 * that differs from an earlier one proves the host restarted since. Undefined when none can be
 * read or it is malformed (the deployment then has no restart evidence for this machine).
 */
export function readBootId(sources: BootIdSources = realSources): string | undefined {
  let id: string | undefined;
  if (sources.platform === "linux") {
    id = attempt(() => sources.readFile("/proc/sys/kernel/random/boot_id"));
  } else if (sources.platform === "darwin") {
    id = attempt(() => sources.sysctl("kern.bootsessionuuid"));
    if (!id) {
      const raw = attempt(() => sources.sysctl("kern.boottime"));
      id = raw === undefined ? undefined : bootTimeId(raw);
    }
  }
  return isDeviceBootId(id) ? id : undefined;
}

let cached: { value: string | undefined } | undefined;

/** {@link readBootId} once per process: the boot cannot change while the program runs. */
export function currentBootId(): string | undefined {
  cached ??= { value: readBootId() };
  return cached.value;
}
