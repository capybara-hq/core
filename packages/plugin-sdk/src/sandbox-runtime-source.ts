import { LINUX_SANDBOX_SOURCE } from "./sandbox-linux-runtime-source.js";
import { NATIVE_FILES_SOURCE } from "./sandbox-native-runtime-source.js";

/**
 * Immutable runtime bytes for trusted consumer staging (requires Python 3). Consumers verify every
 * hash before use, stage the files together in a directory the operation user cannot write, and
 * supply pinned, already-authorized root descriptors.
 *
 * - `native-files.py`: the portable native helper (descriptor-relative file access).
 * - `linux-sandbox.py`: the restricted Linux launcher and syscall broker (Landlock plus a seccomp
 *   notification broker). It decides nothing about authority; its `probe` reports whether the
 *   running kernel, architecture and container policy support restricted execution, and every
 *   unsupported case reports unavailable. Shipping these bytes is not a provider support claim.
 */
export const SANDBOX_RUNTIME_SOURCE: {
  readonly version: number;
  readonly files: readonly {
    readonly name: string;
    readonly source: string;
    readonly sha256: string;
  }[];
} = Object.freeze({
  version: 2,
  files: Object.freeze([
    Object.freeze({
      name: "native-files.py",
      source: NATIVE_FILES_SOURCE,
      sha256: "a9799b4fe9508991640194d943d2da83f74a477e3a9c681df5362c59b848b47c",
    }),
    Object.freeze({
      name: "linux-sandbox.py",
      source: LINUX_SANDBOX_SOURCE,
      sha256: "ea09f2b51d79b2832971cfb60c39025a117863fdfebd0ecac92ac9aa07055c46",
    }),
  ]),
});
