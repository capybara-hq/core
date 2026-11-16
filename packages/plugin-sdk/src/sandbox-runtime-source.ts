import { NATIVE_FILES_SOURCE } from "./sandbox-native-runtime-source.js";

/**
 * Immutable portable native helper bytes for trusted consumer staging (requires Python 3).
 * Consumers verify hashes before use and supply pinned, already-authorized root descriptors.
 * This bundle declares no restricted-runtime support; enforcement and launch belong to providers.
 */
export const SANDBOX_RUNTIME_SOURCE: {
  readonly version: number;
  readonly files: readonly {
    readonly name: string;
    readonly source: string;
    readonly sha256: string;
  }[];
} = Object.freeze({
  version: 1,
  files: Object.freeze([
    Object.freeze({
      name: "native-files.py",
      source: NATIVE_FILES_SOURCE,
      sha256: "601f51c1c46bedac5ab56f7ca38d7c15fdea8481efc6476d5a5b3243318ef79b",
    }),
  ]),
});
