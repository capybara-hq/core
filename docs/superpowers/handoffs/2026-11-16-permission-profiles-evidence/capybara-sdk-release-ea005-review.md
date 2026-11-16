# PR #316 prerelease metadata review

Verdict: **Ready — metadata review only.** No blocking metadata finding. This is not a claim that the release is ready to publish: the parent-owned build, tarball, isolated install, and public-entry import checks listed below remain required before the merge that triggers publication.

- Base: `5408b24e83fae1559858f1811f9d2f0c60594016` (accepted SDK #317, after #318).
- Release head: `ea005ea9dd596f9ad9b2e09014dc1531376ea5f1`.
- Checkout: `/Users/grant/.codex/worktrees/permission-native-sdk/core`; clean at both initial and final inspection.
- Scope: all 29 changed files, 138 insertions / 17 deletions, plus focused package/export/release context. No repository edits, source execution, builds, installs, tests, publication, merge, secret reads, or outward posts performed by this reviewer.
- Instructions: primary repository `AGENTS.md`, `.agents/skills/reviewing-prs/SKILL.md`, and `docs/deploy/release.md`. The accepted SDK implementation was checked for inclusion and unchanged scope; it was not reviewed again.

## Findings

- **Critical:** None found in the reviewed metadata.
- **Important:** None found in the reviewed metadata. Artifact verification is outstanding evidence, not a discovered metadata defect.
- **Minor:** None requiring a change. `git diff --check` reports generated changelog blank-line whitespace at `apps/web/CHANGELOG.md:8,10`, `packages/design/CHANGELOG.md:8,10`, `packages/plugin-sdk/CHANGELOG.md:10`, and `packages/testing/CHANGELOG.md:10`; this is not a release correctness finding and no formatting changes are proposed.

## Confirmed release contents

| Package | Version at reviewed head | Evidence |
| --- | --- | --- |
| `@capybara-hq/plugin-sdk` | `0.1.0-rc.25` | `packages/plugin-sdk/package.json:3` |
| `@capybara-hq/testing` | `0.1.0-rc.20` | `packages/testing/package.json:3` |
| `@capybara-hq/kernel` | `0.1.0-rc.35` | `packages/kernel/package.json:3` |
| `@capybara-hq/plugin-tools` | `0.1.0-rc.15` (unchanged) | `packages/plugin-tools/package.json:3` |
| `@capybara-hq/device` | `0.1.0-rc.13` | `packages/device/package.json:3` |
| `@capybara-hq/capybara`, `@capybara-hq/web` | `0.1.0-rc.36` | each app's `package.json:3` |
| `@capybara-hq/design` | `0.2.0-rc.9` | `packages/design/package.json:3` |
| `@capybara-hq/plugin-model-fake` | `0.1.0-rc.26` | `plugins/model-fake/package.json:3` |

1. SDK package version, `SDK_VERSION` (`packages/plugin-sdk/src/index.ts:1`) and generated API literal (`packages/plugin-sdk/api/plugin-sdk.api.md:3125`) all equal `0.1.0-rc.25`. The API report changes only that version literal. Model-fake's manifest (`plugins/model-fake/.capybara-plugin/plugin.json:8`) and extension declaration (`plugins/model-fake/src/index.ts:78`) agree with its package version. These two source diffs change version strings only.
2. Accepted scoped contracts and parsers remain exported at `packages/plugin-sdk/src/index.ts:30`; the immutable native helper bundle remains exported at line 31. Optional `operation`, `prepare`, `browse`, `revokeOperation`, permission support and background capabilities remain optional in `packages/plugin-sdk/src/sandbox.ts:227`. Once background is supported, `SandboxBackground.readOutput` remains required at `packages/plugin-sdk/src/sandbox-operation.ts:267`, and in the API report at line 2803. Its retained-output bounds and committed-position contract remain intact at source lines 250–274.
3. Native conformance remains publicly exported at `packages/testing/src/index.ts:226`. Its fixture obtains a fresh operation per native invocation (`packages/testing/src/sandbox-native-conformance.ts:29`). No code in these implementation files changed between base and release head. Device protocol remains version 2 (`packages/plugin-sdk/src/device-protocol.ts:21`), and existing provider methods are untouched.
4. SDK changelog lines 7–14 and testing changelog lines 7–12 accurately preserve the three accepted SDK changesets. They explicitly disclaim restricted-runtime support, a Linux launcher, a network broker, and full permission conformance. This matches `packages/plugin-sdk/src/sandbox-runtime-source.ts:3` and `packages/testing/src/sandbox-native-conformance.ts:21`. Nothing in the release diff claims an active restricted Linux runtime or activates the optional contracts.
5. All seven consumed changesets move into `.changeset/pre/` without content changes. `.changeset/pre.json:2` remains `mode: pre`, and line 3 remains `tag: rc`. No stable version, pre-mode exit, release-workflow modification, or extra behavioral change appears in this diff. Compose defaults at `docker/compose.yaml:37,242,252,277` and the example at `docker/.env.example:62` all move to the app/image version `0.1.0-rc.36`.
6. Publish export maps still select built `dist` entries and remove the development source condition: SDK `packages/plugin-sdk/package.json:24`, testing `packages/testing/package.json:32`, kernel `packages/kernel/package.json:26`, and plugin-tools `packages/plugin-tools/package.json:47`. Their package file lists include `dist`. This establishes intended layout only, not actual tarball completeness.

## Public testing dependency closure and remaining artifact checks

`@capybara-hq/testing` is not a standalone native-helper entry: its public root eagerly re-exports kernel code (`packages/testing/src/index.ts:6`) and the model conformance module (`:219`), which imports Vitest. Its manifest requires kernel (`packages/testing/package.json:59`), SDK and Vitest peers (`:78–79`), and an optional plugin-tools peer (`:80–84`). The packer is loaded only when needed from `@capybara-hq/plugin-tools/pack` (`packages/testing/src/fixtures.ts:113`). Kernel requires SDK (`packages/kernel/package.json:46`); plugin-tools requires both (`packages/plugin-tools/package.json:81–82`). No dependency is newly missing from source metadata.

Before publication, the parent should establish all of the following using the exact reviewed head and without workspace source resolution:

1. Build and pack the actual versioned SDK, kernel and testing artifacts. Inspect their tarball manifests: exact versions above; no `workspace:` ranges, `@capybara-hq/source` conditions, or unapplied `publishConfig`; rewritten testing ranges for kernel `^0.1.0-rc.35`, SDK `^0.1.0-rc.25`, plugin-tools `^0.1.0-rc.15`; kernel's SDK range `^0.1.0-rc.25`.
2. Verify the SDK tarball contains the runtime `.js` and `.d.ts` files for the operation contracts, runtime bundle and native-source module; testing contains the native-conformance runtime and declarations. Verify compiled `SDK_VERSION`, package version and declarations match rc.25. Check helper bundle bytes against its advertised SHA-256 and immutable bundle shape using the packed public SDK export.
3. Install those tarballs in an isolated consumer directory outside the workspace, with normal published dependency resolution and explicit Vitest peer satisfaction. Resolve the public package entries from that installation. Exercise testing's public root in an appropriate Vitest context because the root imports Vitest test APIs; a naked Node import is not an adequate substitute. Confirm `runSandboxNativeConformance` is reachable, and compile a consumer using `SandboxOperation`, `SandboxBrowse`, `SandboxBackground.readOutput`, the exported parsers/errors, runtime bundle, and fixture types.
4. Cover plugin-tools rc.15 separately: verify the existing public rc.15 artifact and its declared dependency closure, or inspect the exact planned artifact if it is still unpublished. Confirm `@capybara-hq/plugin-tools/pack` resolves and a fixture-pack path works when that optional peer is installed. Do not assume a locally repacked unchanged version equals an already published tarball. Confirm testing's ordinary public-root/native-conformance use works without this optional peer.
5. Verify registry prerequisites and planned publish order: SDK then kernel before testing; plugin-tools is optional for testing and may follow it (`packages/plugin-tools/src/release/publish-plan.ts:54`). All four must be usable from their public package entries for the complete testing/toolchain installation. Exact availability, integrity, provenance and dist-tags were not queried by this reviewer. Prerelease publication selects `next` (`publish-plan.ts:38`); it must not promote stable/`latest`.

## Gate and authorization limits

Current PR #316 CI, issue-linked status, approval state, registry availability, actual tarball contents, and runtime import/install results were not independently observed here. Earlier source CI acceptance for #317/#318 was supplied by the parent and does not replace the checks above.

Merging this version PR is a publication boundary: `.github/workflows/release.yml:90` runs on a push to main, and its independent publish job uses the committed SHA (`:166`) and `pnpm release --auto` (`:213`). The release plan publishes versions missing from npm and skips versions already present. A metadata-ready verdict therefore must not be read as evidence that the still-pending artifact gate passed.
