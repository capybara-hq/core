# Release runbook (maintainers)

Releases come from `.github/workflows/release.yml`, which runs on push to `main` and on manual dispatch,
never on pull requests. One run publishes:

- **npm:** `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/testing`,
  `@capybara-hq/plugin-tools` (the `capybara-plugin` toolchain), and `@capybara-hq/plugin-model-fake`
  (the scripted model provider, which stays in core), each with npm provenance. The root `release`
  script passes `--plugins plugins/model-fake`, so no other plugin under `plugins/` is ever published
  from core: every other official plugin is published by `capybara-hq/plugins` with the same code
  (`capybara-plugin release`), and its provenance names that repository.
- **Container images:** `ghcr.io/capybara-hq/capybara-api`, `capybara-worker`, `capybara-gateway` and
  `capybara-web`, for linux/amd64 and linux/arm64. Each has SLSA provenance (mode=max) and an SBOM.
  - The tag is the version of `apps/capybara` (`@capybara-hq/capybara`, private and versioned by
    changesets), plus `latest` (see below).
  - **Image gate:** while `packages/kernel/bootstrap.json` has a `"source": "workspace"` entry, the
    image plan builds nothing (push and manual runs; a dry run still builds) and says so in a run
    notice: "bootstrap.json has workspace entries: images are released only with npm-pinned
    bootstrap plugins". An image bakes the bootstrap plugins, and a released image must carry the
    packages published by `capybara-hq/plugins`, never a pack of core's plugin sources. The other
    image gates (stable images need stable pins, promotion is manual) are under "Gates that keep the
    order" below.
- **A git tag `v<version>` and a GitHub release** (the `apps/capybara` version) on the commit the
  images were built from, once every image of the run is pushed. Prereleases are marked prerelease,
  and a version below `latest` (a backport) doesn't become the latest release.
- **Workflow artifact `npm-plugin-packages`:** the plugin tgz files published in that run (from core,
  only model-fake), with `SHA512SUMS` and `integrity.json`. It is kept for 90 days.

## Prerequisites (once, before the first release)

npm:

1. The npm scope `@capybara-hq` exists and you control it. `npm org ls capybara-hq` and
   `npm access list packages @capybara-hq` work for the publishing account.
2. **Repository secret `NPM_TOKEN`:** a granular access token with read and write on the
   `@capybara-hq` packages that can publish without interactive 2FA.
   - It is required for the first publish, because npm trusted publishing is configured per existing
     package.
   - Later you may set up trusted publishing (OIDC) for each package, with repository
     `capybara-hq/core` and workflow `release.yml`, and then delete the secret. The workflow already
     has `id-token: write`. This fallback hasn't been tested live yet.
3. **Repository secret `RELEASE_PR_TOKEN` (recommended):** a fine-grained PAT or GitHub App token with
   Contents and Pull requests read/write on the repository, set in **both** `capybara-hq/core` and
   `capybara-hq/plugins` (each repository's own secret; one token may cover both).
   - A Version Packages PR opened or updated with `GITHUB_TOKEN` doesn't trigger `ci.yml`, so
     `ci-ok` never reports on it.
   - Without this secret, trigger CI by hand: close and reopen the PR, or push an empty commit.

GitHub and ghcr.io:

4. **`capybara-hq/core` is public.**
   - npm provenance rejects private source repositories, and each package's `repository.url` must
     match (`check:release-metadata` enforces it).
   - The image builds use the native arm runners `ubuntu-24.04-arm`, which are free only for public
     repositories. A private repository needs paid larger arm runners, or a switch back to QEMU.
5. **Actions settings** (repository, and the org if it sets policy):
   - Settings → Actions → General → Workflow permissions must let jobs request `packages: write`. The
     read-only default is fine, because every job declares its own permissions. An org policy that
     caps tokens at read blocks the image push.
   - Turn on "Allow GitHub Actions to create and approve pull requests", so `changesets/action` can
     open the Version Packages PR when `RELEASE_PR_TOKEN` isn't set.
6. **Org package policies:** Org → Settings → Packages → Package creation must allow **public**
   container packages. Otherwise the packages can't be made public later.
7. **No conflicting packages:** no existing package in the org may be named `capybara-api`,
   `capybara-worker`, `capybara-gateway` or `capybara-web` while linked to another repository.
   `GITHUB_TOKEN` pushes would fail with 403.
8. **After the first real run** creates the four container packages (they start private):
   - set each one's visibility to **Public**;
   - check under "Manage Actions access" that `capybara-hq/core` has **Write**. The OCI source label
     normally links it, and "Inherit access from source repository" works too.

   Until the packages are public and linked, automatic runs fail loudly (`denied`) instead of skipping.
9. No pending changeset before the first release: they were removed, and the published core packages,
   `apps/capybara` and `apps/web` were set to `0.1.0-rc.0` by hand, so the first changelog entry is
   the initial release. Changesets are in pre mode with the tag `rc` (`.changeset/pre.json`, see
   below). `ls .changeset` shows only `config.json` and `pre.json`.
10. **Nothing older can publish (before R1, once):** delete every earlier run of the Release workflow
    (Actions → Release → each run → "Delete workflow run"; or `gh run list --workflow release.yml`
    and `gh run delete <id>`). "Re-run" on an old run uses that run's own commit and code, which
    published every plugin from core and had no image gate. Also delete the stale
    `changeset-release/main` branch and close its "Version Packages" PR (it bumped the old changesets
    to 0.1.1); `version-pr` recreates the branch from the current changesets when it next has some.

## The first release: 0.1.0-rc.0, acceptance, then 0.1.0

The first release is a release candidate. Every package is published at `0.1.0-rc.0` (npm dist-tag
`next`, images without `latest`, a GitHub prerelease), the maintainer accepts the system in its final
shape (plugins from `capybara-hq/plugins`, `bootstrap.json` holding npm pins only), fixes found in
acceptance ship as further rcs (`0.1.0-rc.1`, ...), and then everything is promoted to `0.1.0`
(`latest`). Every round goes out in the same order (plan
`docs/superpowers/plans/2026-10-26-ecosystem-phase-a3b-split-release.md`):

- **R1, core libraries** (this repository): `plugin-sdk`, `kernel`, `testing`, `plugin-tools` and
  `plugin-model-fake`.
- **R2, plugins** (`capybara-hq/plugins`): every public plugin, each pack's sha512 equal to its
  `marketplace.json` entry.
- **R3, core images:** a core PR pins `bootstrap.json` to the R2 packages (`"source": "npm"`, at the
  plugins repository commit that lists them) **and bumps `apps/capybara` / `apps/web`** (a changeset
  on `@capybara-hq/capybara`; not needed in the first round, whose `0.1.0-rc.0` images were never
  built), so the images of the round bake the round's plugins. Then the tag `v<version>` and its
  GitHub release.

### One commit pins what core takes from `capybara-hq/plugins`

`marketplace.commit` in `packages/kernel/bootstrap.json` pins three things at once:

1. the bootstrap entries (their versions and sha512 must be listed in that commit's
   `.capybara-plugin/marketplace.json`; `bootstrap-marketplace`);
2. the compose sandbox build contexts (`docker/compose.yaml`, `docker/compose.dev.yaml`: exactly
   `https://github.com/capybara-hq/plugins.git#<commit>:<dir>`, with a `Dockerfile` there;
   `bootstrap-compose-ref`);
3. the sandbox-docker plugin's test copy of the socket proxy config, which must equal
   `docker/sandbox-proxy/haproxy.cfg` byte for byte (`bootstrap-haproxy`).

Moving the commit moves all three, and the PR must pass `pnpm check:bootstrap --network` (CI runs it
when `bootstrap.json` or `docker/**` changes). A change to the socket proxy config alone goes into
`capybara-hq/plugins` first (`plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg`, with a test
against the real proxy), then a core PR changes `docker/sandbox-proxy/haproxy.cfg` (and the copy
inlined in `docker/compose.yaml`, `check:compose-haproxy`) and moves `marketplace.commit` and the
compose contexts to a plugins commit that has it. The pins must be the versions that commit's
`marketplace.json` lists (one entry per plugin, its current version), so the pins usually move
with it. No image bakes the proxy config (it
is a compose `configs` entry), so this needs no changeset.

### Gates that keep the order (all in code)

- **First release:** on push, `pnpm release --auto` refuses while none of our packages is on npm, and
  the image planner builds nothing until then. The first rc is a manual run.
- **Workspace pins:** while `bootstrap.json` has a `"source": "workspace"` entry, images are never
  built (push or manual). In the first round the images therefore wait for R3.
- **Stable images need stable pins:** a stable `apps/capybara` version (e.g. `0.1.0`) with any
  prerelease npm pin plans no image, push or manual. An rc image with stable pins is fine.
- **Promotion is manual:** a push never publishes a stable version whose highest npm version is a
  prerelease of it (`0.1.0` after `0.1.0-rc.N`; the whole run publishes nothing), and never builds a
  stable image whose highest image tag is a prerelease of it. A manual run (`dry_run: false`) does
  both, like the first release.

An image built in a later rc round at R1 (a kernel changeset also bumps `apps/capybara`, a dependent)
bakes the previous round's pins; that is a valid intermediate rc, and R3's bump builds the round's
images.

### Changesets in pre mode

While the release is a candidate, changesets are in **pre mode** with the tag `rc`
(`.changeset/pre.json`, committed; `tools/release/test/workflow.test.ts` fails if the kernel is a
prerelease and pre mode is off). A changeset then versions `0.1.0-rc.N` to `0.1.0-rc.N+1`, never to
`0.1.0` (outside pre mode semver would bump a prerelease straight to its release). Further rcs
therefore go through changesets and the Version Packages PR as usual, and pushes publish them (npm
has the first one). `pnpm version-packages` also syncs `SDK_VERSION` and the SDK API report
(`pnpm sync:sdk-version`), the plugin manifests, the compose image tag and the workspace pins.

### Steps

1. Actions → **Release** → Run workflow on `main` with **`dry_run: true`**.
   - It builds and packs the five packages and runs `npm publish --dry-run`: the plan lists them at
     `0.1.0-rc.0` with `tag next`.
   - It builds all four images for both architectures (8 jobs) and pushes nothing.
   - Fix anything that fails. A dry run may also run from another ref.
2. Run it again on `main` with **`dry_run: false`** (R1). A real manual publish is refused from any ref
   other than `main`.
3. Check: `npm view @capybara-hq/kernel dist-tags` shows `next: 0.1.0-rc.0` (the npm registry also
   points `latest` at the first version a package ever publishes, whatever its tag, so `latest` may
   name the rc until 0.1.0 takes it over); each package has provenance (`npm view --json
   @capybara-hq/kernel@0.1.0-rc.0 dist.attestations`); the image jobs planned nothing (gate notice in
   the run summary); no tag `v0.1.0-rc.0` yet.
4. R2 in `capybara-hq/plugins` (its own runbook), then R3 here: merge the pins PR (it moved the
   plugins out of core and pinned `bootstrap.json` to npm). In the first round its push cannot build
   the images: no image package exists on ghcr.io yet, so every tag lookup answers `denied` and the
   push run's `images-plan` fails on purpose (after the first npm release a push never reads
   `denied` as "missing"; see "First release with no image at all" below). The push publishes
   nothing to npm either (no version changed). Run the Release workflow manually on `main`
   (`dry_run: false`): it builds and pushes the four `0.1.0-rc.0` images, without `latest` (a
   prerelease), and the GitHub prerelease. In later rounds the packages exist and the push of the
   pins PR builds the images itself (if that run is cancelled or fails, a manual run builds the
   missing tags). Then do
   prerequisite 8 (make the four container packages public) and check `docker buildx imagetools
   inspect ghcr.io/capybara-hq/capybara-api:0.1.0-rc.0`, the tag `v0.1.0-rc.0` and its GitHub
   prerelease, and `docker compose pull` with `docker/compose.yaml` at that tag (its default image
   tag is the rc).
5. **Acceptance** on the published rc. Fixes are ordinary PRs with changesets; their Version Packages
   PR produces the next rc, released in the same R1 → R2 → R3 order.
6. **Promote to 0.1.0** (core first, then the plugins repository, then core's pins):
   - A reviewed core PR runs `pnpm changeset pre exit` and then `pnpm version-packages`, and commits
     the result. Leaving pre mode promotes **every** package that is at a prerelease to its release
     version, with or without a changeset during pre mode (`0.1.0-rc.N` → `0.1.0`; `apps/capybara`
     and `apps/web` too); the changesets kept under `.changeset/pre/` become the changelog, and
     `pre.json` is deleted. Running the version step in the PR itself, rather than waiting for a
     Version Packages PR, keeps the promotion reviewable in one diff.
   - Its push publishes nothing (promotion is refused on push) and builds no image (stable image,
     rc pins). Run the Release workflow manually: R1 publishes the libraries at `0.1.0` under
     `latest`.
   - R2: the plugins repository does the same (`pre exit`, version, manual release, new
     `marketplace.json` entries).
   - R3: a core PR pins `bootstrap.json` and `marketplace.commit` to the `0.1.0` plugins. Its push
     still builds no image (promotion of an rc image is manual): run the Release workflow manually.
     The images take `latest` (rc tags don't count), and `v0.1.0` becomes the latest GitHub release.

Locally, after `pnpm build`, `pnpm release --dry-run` shows the npm plan, and
`pnpm release:images --mode manual` shows the image plan (the gate notice while `bootstrap.json` has
workspace entries); `--mode dry-run` builds everything regardless.

## Later releases: changesets

1. Every PR that changes a published package adds a changeset (`pnpm changeset`).
2. On push to `main`, the `version-pr` job opens or updates the **"chore: version packages"** PR from
   the pending changesets. It never publishes.
3. Review and merge that PR. The push of the merge runs `publish` (`pnpm release --auto
   --provenance`), which publishes every version in the committed `main` tree that isn't on npm yet.
   Then the image jobs build and push every image whose version tag isn't on ghcr.io yet.

The two jobs are deliberately separate. `changeset version` rewrites versions in the `version-pr`
checkout. The `publish` job checks out exactly `github.sha` on a fresh runner and refuses to run with
uncommitted `package.json` changes, so only reviewed versions ship.

### Order across repositories, and downtime

- **Core first.** Release core (kernel, plugin-sdk, plugin-tools, plugin-model-fake) and upgrade the
  deployed kernels before `capybara-hq/plugins` publishes plugins whose `plugin.json` `description` is
  an object (`{ en, zh? }`): older kernels reject it. The same goes for the official marketplace
  dropping older versions of a plugin: kernels that still need them must be upgraded first.
- **No rolling upgrade across the super-admin rename.** Migration 0080 renames a column of
  `accounts` (the old admin flag becomes `is_super_admin`), so a replica of the old version cannot
  run against the migrated schema. Replace all replicas at once (stop, migrate,
  start) for this version; expect a short downtime.

### The compose image tag

`docker/compose.yaml` pulls `${CAPYBARA_VERSION:-<version>}`, and `docker/.env.example` shows the
same version. The workflow runs `pnpm version-packages` (`changeset version`, then `pnpm
sync:image-tag`) for the Version Packages PR, so the PR rewrites both to the new `apps/capybara`
version. `check:release-metadata` fails when they differ, for example after running `changeset
version` by hand: run `pnpm sync:image-tag`.

### Git tags and GitHub releases

The `release-tag` job runs after `images-publish`, only in the run that pushed images. It tags
`github.sha` `v<version>` and creates a GitHub release; when the release already exists it does
nothing. If it fails, re-run the failed job: it tags the same commit. A later push with the same
version doesn't tag, because it would point the tag at a newer tree than the images.

### Image versions and the fixed group

- `.changeset/config.json` puts `@capybara-hq/capybara` and `@capybara-hq/web` in a **fixed group**,
  so they always carry the same version. `check:release-metadata` (part of `pnpm check`) fails when
  they differ or the group is missing.
- A change to `apps/web` therefore bumps the image tag.
- **A change that only touches the images** (Dockerfiles, `.dockerignore`, runtime files baked into an
  image) **needs a changeset on `@capybara-hq/capybara`.** Without one, the version doesn't change and
  the images are never rebuilt.

### `latest`

An image gets `latest` when its version has no prerelease part and is at least as high as every
stable semver tag already in ghcr.io:

- Prerelease tags (e.g. `0.2.0-rc.1`) never get `latest` and don't count in the comparison.
- Re-running an old release builds that version without `latest`, so `latest` never moves back.
- In a manual run, an image whose tag lookup was `denied` doesn't get `latest`. The first image
  release is the exception: every lookup is `denied` and ghcr.io shows no tag at all, because none of
  the four packages exists yet, and npm shows no version other than this run's own (the `publish` job
  of the same run has already put it there when the images are planned). A denied lookup also hides
  existing tags, so a re-run of an older release while access is denied never gets `latest`.
- `latest` is pushed before the version tag. The version tag is the "done" marker the planner looks
  for.

### npm dist-tags

npm follows the same rule as the image `latest` (`distTagFor` in `packages/plugin-tools/src/release/publish-plan.ts`):

- A prerelease (e.g. `0.2.0-rc.0`) is published with `--tag next`.
- A stable version below the highest stable version already on npm (a backport such as 0.1.5 after
  0.2.0) is published with `--tag release-<major>.<minor>` (`release-0.1`).
- Anything else gets `latest`.

So `capybara extensions install npm:@capybara-hq/plugin-slack` without a version never installs an rc
or a backport, and npm >= 11 (which refuses an untagged publish below `latest`) accepts backports.

## Failures and re-runs

- **Self-healing (every push):** a push doesn't check whether it bumped a version. It publishes
  whatever committed versions are missing from npm, and builds whatever image tags are missing from
  ghcr.io. GitHub keeps only one pending run per concurrency group, so a queued run can be cancelled
  by a newer one; the newer run still publishes what the cancelled one would have. A failed run is
  caught up by the next push to `main`.
- **Re-running a failed run** (Actions → the run → "Re-run failed jobs") is safe.
  - npm versions already published are skipped.
  - The image jobs rebuild only the `apps/capybara` version of that run's own commit, so an old run
    never builds a newer, unreleased tree.
  - `images-publish` tags an image only when both architectures built, so one run never tags half the
    images.
- **A manual run (`dry_run: false`)** publishes whatever is missing for `main`'s HEAD. It also finishes
  a release that failed halfway.
- **First release with no image at all:** if the first manual run published npm but every image build
  failed, the packages don't exist yet. ghcr.io then answers `denied`, and push runs fail until a
  manual run publishes the images. Once every package has at least one image, push runs catch up by
  themselves.
- Repeated image failures are expensive: each push to `main` retries every missing image build, about
  8 jobs, until the cause is fixed.

## Cache budget

Image layers are cached in the GitHub Actions cache, per Dockerfile and architecture
(`kernel-amd64`, `kernel-arm64`, `web-amd64`, `web-arm64`, mode=max). The release image builds write
them. The `docker` job in `ci.yml` reads the amd64 scopes and writes them only on pushes to `main`,
never on PRs. Together with the pnpm caches, this can approach the 10 GB per-repository limit. When
it's reached, GitHub evicts the least recently used entries: builds get slower (cold), but stay
correct.

## Appendix: the release workflow in brief

- **npm release** (`.github/workflows/release.yml`, `pnpm release`): never on PRs; runs on push to `main` and on `workflow_dispatch`, in two jobs that share nothing: `version-pr` (push only, changesets/action, no npm token or id-token) opens / updates the "Version Packages" PR, using the optional `RELEASE_PR_TOKEN` so the PR's CI runs; its version command `pnpm version-packages` runs `changeset version`, then `sync:plugin-versions` (`capybara-plugin sync-versions`: copies each plugin's `package.json` version into its `plugin.json` and extension manifest, which the packer requires equal), `sync:sdk-version` (`SDK_VERSION` from the SDK's `package.json`, then `gen:sdk-api`), `sync:image-tag` and `check:bootstrap --write` (the bootstrap pins in `packages/kernel/bootstrap.json` are a release artifact; `tools/release/test/workflow.test.ts` pins this order); `publish` (fresh checkout of `github.sha`, `contents: read` + `id-token`) publishes, on every push (`pnpm release --auto`), the versions of the committed main tree that are not on npm yet (they only change when the reviewed Version Packages PR merges; no per-push bump check, so a cancelled queued run is caught up by the next), refusing while nothing is on npm yet, and refusing (publishing nothing) when a package would be promoted from a release candidate (a stable version whose highest npm version is a prerelease of it): the first release and each promotion are manual. While the release is a candidate, changesets run in pre mode with the tag `rc` (`.changeset/pre.json`), so a changeset versions `0.1.0-rc.N` to `-rc.N+1`; promotion is a reviewed PR running `changeset pre exit` and `pnpm version-packages` (see `docs/deploy/release.md`). `tools/release/test/workflow.test.ts` pins this layout. The first release (the release candidate `0.1.0-rc.0`; acceptance, then further rcs and the final 0.1.0 follow as ordinary releases) is published only by a manual `workflow_dispatch`. Publishes the SDK, kernel, testing and plugin-tools, in that order (`pnpm pack` then `npm publish`; `pnpm build` runs first), then `model-fake` as its plugin tgz (the root `release` script passes `--plugins plugins/model-fake`: every other official plugin is published by `capybara-hq/plugins`), with `--provenance`, skipping versions already on npm; a prerelease goes to the dist-tag `next`, a backport to `release-<major>.<minor>`, anything else to `latest` (`distTagFor`). `pnpm release` is `capybara-plugin release` of `packages/plugin-tools` (the npm half; the plugins repository reuses it), run from source.
- **Image release** (same workflow, jobs `images-plan` -> `images-build` -> `images-publish`, after `publish` succeeds): never on PRs. Pushes `ghcr.io/capybara-hq/capybara-{api,worker,gateway,web}` for linux/amd64 + arm64 (native `ubuntu-24.04` / `ubuntu-24.04-arm` runners, pushed by digest, then joined with `docker buildx imagetools create`), tagged with the `apps/capybara` version plus `latest` (only for a version without a prerelease part and not lower than any stable semver tag already in ghcr.io, so re-running an old release never moves it back; not for an image whose tag lookup was denied after the first release), with provenance (mode=max), SBOM and the `org.opencontainers.image.source` label. `pnpm release:images` (`tools/release/src/images.ts`) plans it: nothing at all (a run notice says why; a dry run still builds) while `packages/kernel/bootstrap.json` has a `"source": "workspace"` entry, because a released kernel downloads its bootstrap plugins from npm and could not obtain a workspace entry, or when a stable `apps/capybara` version would pin a prerelease npm package; on push also nothing for a stable version whose highest image tag is a prerelease of it (promotion is manual); on push nothing until the first npm release exists (the first release, npm and images, is the manual run), then every image whose version tag is missing in ghcr.io (self-healing like npm; a run builds only the `apps/capybara` version of its own commit, so re-running an old failed run rebuilds that version from that commit); a manual run builds the missing tags; a dry run builds all four and pushes nothing. If the first manual run published npm but no digest of some image (its builds all failed, or, as in the first rc round, the workspace gate held them back), that package doesn't exist yet, ghcr.io answers "denied" and push runs fail until a manual run publishes it; once every package exists, push runs catch up. Uses only `GITHUB_TOKEN` (`packages`). **A change that only affects the images** (Dockerfiles, `.dockerignore`, runtime files baked into an image) **needs a changeset on `@capybara-hq/capybara`**, otherwise no new tag is ever built; `@capybara-hq/web` is in the same `fixed` group, so web changes bump the tag by themselves.
