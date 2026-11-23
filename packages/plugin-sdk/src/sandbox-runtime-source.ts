import { LINUX_SANDBOX_SOURCE } from "./sandbox-linux-runtime-source.js";
import { NATIVE_FILES_SOURCE } from "./sandbox-native-runtime-source.js";

/**
 * A capability of a runtime file that a consumer may use only when the file it runs declares it.
 * `fileReadRoots`: `linux-sandbox.py` accepts exact file read roots (`roots.readFiles`, exec mode).
 */
export type SandboxRuntimeFeature = "fileReadRoots";

/** One runtime file: its exact bytes and their sha256 (hex). */
export interface SandboxRuntimeFile {
  readonly name: string;
  readonly source: string;
  readonly sha256: string;
  /** What this revision supports beyond the bundle's base protocol; absent means nothing more. */
  readonly features?: readonly SandboxRuntimeFeature[];
}

const NATIVE_FILES: SandboxRuntimeFile = Object.freeze({
  name: "native-files.py",
  source: NATIVE_FILES_SOURCE,
  sha256: "c1712198af4ffedc0b48f789c28ed4233dc9008521b897300731c4f903168950",
});

const LINUX_SANDBOX: SandboxRuntimeFile = Object.freeze({
  name: "linux-sandbox.py",
  source: LINUX_SANDBOX_SOURCE,
  sha256: "ceb5bb0971437978a7695091792bfafcf3dbf2e7c74e8425d8aceb76e442f848",
  features: Object.freeze(["fileReadRoots"] as const),
});

const STAGED = Object.freeze([NATIVE_FILES, LINUX_SANDBOX]);
const CURRENT = STAGED;

/**
 * Digests of earlier revisions a staged copy may still have (one previous revision at most):
 * device containers made from an earlier image keep their staged runtime until recreated. The
 * launcher before exact file read roots (core#742); the next runtime change drops it.
 */
const PREVIOUS: readonly Pick<SandboxRuntimeFile, "name" | "sha256">[] = Object.freeze([
  Object.freeze({
    name: "linux-sandbox.py",
    sha256: "4e046df902dc644532ada9f2a3bef30a983daf7d1f238bd46dcd16524d96c66c",
  }),
]);

function acceptedDigests(
  ...sets: readonly (readonly Pick<SandboxRuntimeFile, "name" | "sha256">[])[]
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {};
  for (const set of sets)
    for (const file of set) {
      const list = out[file.name] ?? [];
      if (!list.includes(file.sha256)) list.push(file.sha256);
      out[file.name] = list;
    }
  for (const name of Object.keys(out)) Object.freeze(out[name]);
  return Object.freeze(out);
}

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
 *
 * Two sets, because an image provider (device-docker) builds the bytes into its image in another
 * repository and release, while the host SDK moves with the kernel:
 *
 * - `files`: the staged set, exactly what released image providers stage and check against the
 *   host SDK. It changes only in the core change that moves `marketplace.commit` and the
 *   device-docker pin to an image staging it.
 * - `current`: the newest runtime. A consumer that carries the bytes itself (capybara-device sends
 *   them inline with every request) runs these, and uses a capability only when the file it runs
 *   declares it in `features`; an image provider restages from these.
 * - `accepted`: by file name, every digest a staged copy may have: `files` and `current`, plus at
 *   most one previous revision kept for instances built from an earlier image. Only SDK-shipped
 *   digests are listed; nothing configures this.
 *
 * A runtime change therefore lands in three steps (tools/checks/README.md, "Changing the SDK
 * runtime sources"): `current` first, then the provider restages, then core promotes `current` to
 * `files` with the pin. Between changes, as now, `current` is `files`.
 */
export const SANDBOX_RUNTIME_SOURCE: {
  readonly version: number;
  readonly files: readonly SandboxRuntimeFile[];
  readonly current: readonly SandboxRuntimeFile[];
  readonly accepted: Readonly<Record<string, readonly string[]>>;
} = Object.freeze({
  version: 2,
  files: STAGED,
  current: CURRENT,
  accepted: acceptedDigests(STAGED, CURRENT, PREVIOUS),
});
