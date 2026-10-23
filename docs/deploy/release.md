# Release runbook (maintainers)

Releases come from `.github/workflows/release.yml`, which runs on push to `main` and on manual dispatch,
never on pull requests. One run publishes:

- **npm:** `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/testing`, and every
  `plugins/*` package except `example-*`. Plugins are published as packed plugin tgz files. Every
  package gets npm provenance.
- **Container images:** `ghcr.io/capybara-hq/capybara-api`, `capybara-worker`, `capybara-gateway` and
  `capybara-web`, for linux/amd64 and linux/arm64. Each has SLSA provenance (mode=max) and an SBOM.
  - The tag is the version of `apps/capybara` (`@capybara-hq/capybara`, private and versioned by
    changesets), plus `latest` (see below).
- **Workflow artifact `npm-plugin-packages`:** the plugin tgz files published in that run, with
  `SHA512SUMS` and `integrity.json`. It is kept for 90 days and is useful for enterprise catalogs.

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
   Contents and Pull requests read/write on `capybara-hq/core`.
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
9. Pending changesets are removed before 0.1.0, so the first changelog entry is "0.1.0 initial
   release". `pnpm changeset status` should show nothing to release.

## The first release (0.1.0): manual dispatch only

Pushes never publish the first release. On push, `pnpm release --auto` refuses while none of our
packages is on npm yet, and the image planner builds nothing until then. So merging the release work,
or bumping a version before 0.1.0, publishes nothing.

1. Actions → **Release** → Run workflow on `main` with **`dry_run: true`**.
   - It builds and packs every package and runs `npm publish --dry-run`.
   - It builds all four images for both architectures (8 jobs) and pushes nothing.
   - Fix anything that fails. A dry run may also run from another ref.
2. Run it again on `main` with **`dry_run: false`**. A real manual publish is refused from any ref
   other than `main`.
3. Do prerequisite 8: make the four packages public and check their Actions access.
4. Check the result:
   - `npm view @capybara-hq/kernel version`;
   - `docker buildx imagetools inspect ghcr.io/capybara-hq/capybara-api:0.1.0`;
   - `docker compose pull` with `docker/compose.yaml`.

Locally, after `pnpm build`, `pnpm release --dry-run` shows the npm plan, and
`pnpm release:images --mode dry-run` shows the image plan.

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
- In a manual run, an image whose tag lookup was `denied` doesn't get `latest`. The first release is
  the exception, because every package is still missing then.
- `latest` is pushed before the version tag. The version tag is the "done" marker the planner looks
  for.

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

Image layers are cached in the GitHub Actions cache, per Dockerfile and architecture (`kernel-amd64`,
`kernel-arm64`, `web-amd64`, `web-arm64`, mode=max). The release image builds write them. The `docker`
job in `ci.yml` reads the amd64 scopes and writes them only on pushes to `main`, never on PRs. Together with the pnpm caches, this can approach
the 10 GB per-repository limit. When it's reached, GitHub evicts the least recently used entries:
builds get slower (cold), but stay correct.
