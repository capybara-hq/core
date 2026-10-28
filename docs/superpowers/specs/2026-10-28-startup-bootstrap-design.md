# Bootstrap plugins installed at kernel start

Status: agreed with the maintainer on 2026-10-28 (conversation); amends the package ecosystem spec
(`2026-10-22-package-ecosystem-design.md` §7) and the A3b plan's image layout.

## Problem

Today the bootstrap plugins (`packages/kernel/bootstrap.json`: `openai-compatible`,
`object-store-s3`) are downloaded **before** the kernel runs: the image build runs
`pnpm pack-bootstrap` into `/app/bootstrap`, a source checkout has to run `pnpm pack-bootstrap` and
then `capybara start --bootstrap-dir artifacts/bootstrap`. The directory is only a staging area:
once a run is recorded in `bootstrap_runs`, the packages live in PG (`blob_store = 'pg'`) and the
directory is never read again. The extra step is the most confusing part of a first start, and a
source checkout without it silently starts with no model provider and no object store.

## Decision

The bootstrap step is part of kernel start and fetches what it needs itself.

1. **Always on in `capybara start`** (every role). The kernel's `start()` keeps it opt-in for tests
   (`startTestKernel` does not bootstrap unless asked).
2. **Done check first, no I/O.** When `bootstrap_runs` has the manifest's sha256 the step does
   nothing: no directory read, no network. A restart of an installed deployment never needs npm.
3. **Under the advisory lock** (unchanged: one replica runs it, the others wait and then find it
   done), after re-checking "done", the step obtains every entry's tgz, all before writing
   anything:
   - **Offline directory first.** Every `*.tgz` in the bootstrap directory (non-recursive, files
     over `packages.maxBytes` skipped with a warning) is hashed; a file whose sha512 equals an
     entry's `integrity` is that entry's package. The file name does not matter, so the output of
     `npm pack @capybara-hq/plugin-openai-compatible@0.1.0-rc.0` can be dropped in as is. A
     missing directory is the same as an empty one.
   - **Else npm** (`source: "npm"` entries): `fetchNpmPackage` of `packages/npm.ts` with
     `registry = packages.npmRegistry`, `token = packages.npmToken`, `maxBytes =
     packages.maxBytes` and `expectedIntegrity = entry.integrity` (the pin is the only trust
     anchor; the packument's `dist.integrity` is not consulted). Proxy: Node's own
     `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…`, as today.
   - A `source: "workspace"` entry has no download: without a matching file it is
     `bootstrap.missing_file`.
   - Any entry that cannot be obtained fails the whole run before anything is written:
     `bootstrap.missing_file` (a workspace entry without a matching file), the new
     `bootstrap.download_failed` (502: the npm download failed: network, HTTP status, size cap)
     or `bootstrap.integrity_mismatch` (the download's sha512 differs from the pin). Messages name the plugin, version, registry origin and the offline directory,
     and say how to provide the package offline. A required entry failing keeps the kernel from
     listening (unchanged).
   Downloads happen inside the lock so a fleet starting together downloads once.
4. **Directory by convention, overridable by config.** New config key `bootstrap.dir`
   (`CAPYBARA_BOOTSTRAP__DIR`), default `bootstrap`, resolved against the process's working
   directory: `./bootstrap` in a source checkout (gitignored), `/app/bootstrap` in the image
   (working directory `/app`). Not hot. `capybara bootstrap --dir <path>` overrides it for that
   command; `capybara start --bootstrap-dir` is removed (set the config key).
5. **The image carries no packages.** `docker/kernel.Dockerfile` drops the download (and its
   `NPM_REGISTRY` build arg and `NODE_USE_ENV_PROXY`); `/app/bootstrap` exists empty. Compose
   `init` still runs `capybara bootstrap` (now downloading). Offline deployments mount a host
   directory holding the tgz files at `/app/bootstrap`, or point `packages.npmRegistry` at an
   internal mirror.
6. **`pnpm pack-bootstrap` is removed**, and with it `capybara-plugin pack --bootstrap` (and its
   `--registry` / `--npm-token` options when nothing else uses them). The npm fetcher in
   `packages/plugin-tools/src/pack/npm.ts` stays for `check:bootstrap --network`.
7. **Release gates unchanged.** A `source: "workspace"` entry still holds back image releases (a
   released kernel could not obtain it). `check:bootstrap --network` still proves every pin is on
   npm with its integrity, now protecting first starts instead of image builds.

## What changes for people

- Source checkout: `pnpm capybara start` (with `.env`) installs the bootstrap plugins on the first
  start against a fresh database. No `pack-bootstrap`, no `--bootstrap-dir`.
- Compose: unchanged commands; the first `init` needs npm (or the mounted directory / a mirror).
- Air-gapped: `npm pack` the pinned versions elsewhere, copy the files into the bootstrap
  directory (any names), start.
- The rule "only the image build, the web e2e setup and the docker smoke tests download the
  bootstrap plugins" becomes "the bootstrap step of a starting kernel (or `capybara bootstrap`)
  downloads them, once per manifest".

## Not changed

Manifest format, `bootstrap_runs`, the per-entry install / upgrade / keep rules, the advisory
lock, `required` semantics, `check:bootstrap` and its network half, the marketplace pin.
