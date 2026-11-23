# Docker-mode local devices without the host python3

Issue: #718 (split out of #396). Status: approved 2026-11-23 (decisions in §6). Written against
core `main` at `e729f0c1c` (`@capybara-hq/device` `0.1.0-rc.31`).

Related: #704 (login and start check for the host python3 early); the device provider spec
(`2026-11-21-device-provider-design.md`); the permission runtime cutover (installed-byte manifest,
`packages/device/src/exec/runtime-manifest.ts`); the plugins repository's sandbox image
(`plugins/device-docker/image/Dockerfile`, published by its `images.yml` as
`ghcr.io/capybara-hq/capybara-sandbox:<version>`); the writing-device-providers skill.

## 1. Problem, and what is true today

`capybara-device login --mode docker` runs every operation in one long-lived container per device
(`capybara-device-<deviceId>`, `packages/device/src/exec/docker.ts`): read-only root file system,
`--cap-drop ALL`, `no-new-privileges`, the device directory's `workspace` / `tmp` mounted read-write
and `skills` read-only, the user being the host user's uid:gid on Linux and the image's `sandbox`
user on macOS. The operation agent and the restricted launcher already run **inside** that
container with the image's interpreter (`CONTAINER_PYTHON = "/usr/bin/python3"`,
`docker-operations.ts`), their sources sent inline from the verified program.

The program still needs the **host's** `/usr/bin/python3` (`HOST_PYTHON`, `host-python.ts`, passed
as `pythonPath` by `createStagedDevice`) for four things, all on the host:

| Step | Where | What the host interpreter does |
|---|---|---|
| A. Runtime verification | `verify` in `staged-device.ts` -> `collectEnvironment` | Probes the host interpreter (real path, sha256, version, the stdlib files the helpers import) into the environment fingerprint, `imageFingerprint` of the binding's runtime identity. In docker mode none of the helpers whose imports it fingerprints run with that interpreter except B to D. |
| B. Skills preparation | `hostSkillsPreparation` in `docker-operations.ts` | Runs the fixed native helper (`native-files.py`) on pinned, descriptor-relative, no-follow handles to write the host directory behind the read-only `/skills` mount. |
| C. Background output | `ManagedOutputSpool` (`output-spool.ts`), started by the supervisor | Runs `OUTPUT_SPOOL_HELPER` for each background task: a private spool file in the program's state directory plus the published artifact under the host directory behind `/workspace` or `/tmp` (`artifactTarget` maps the container path to the host path). |
| D. Recovered output | `finalizeRecoveredOutput` (`operation-supervisor.ts`) | After a restart, re-verifies and fsyncs a spool the journal names, with the same helper. |

Nothing else needs it in docker mode: the restricted private temp directory and its sweeps only
run for the host transport, the macOS self-check only in OS mode, and `stageRuntimeSource` /
`acquireSealedRuntime` are Node.

Why the helpers are Python at all: B and C need `openat`-style descriptor-relative work with
`O_NOFOLLOW` on every component (`dir_fd`), which Node's `fs` does not offer. C writes into the
workspace, which the container (an untrusted writer) controls: a link planted there must not turn a
host-side write into a write anywhere on the host. That property must survive the change.

Costs today: a Docker-only machine also needs a python3 at exactly `/usr/bin/python3`; on macOS that
is a shim that works only with the Xcode command line tools (a multi-GB install for an unrelated
reason); minimal Linux hosts (some NAS / distroless / immutable distributions) have none. #704 made
the failure early and readable; this design removes the requirement.

A second, smaller gap the same work closes: the device container runs
`ghcr.io/capybara-hq/capybara-sandbox:<tag>` by **tag** (`SANDBOX_IMAGE_TAG`), and the binding
fingerprints whatever image id the container happens to run (`providerImageDigest`). Nothing checks
that id against an image this program version expects, so the container's interpreter (which
already runs the operation agent) is recorded, not attested.

## 2. Decision in one paragraph

The program **pins the sandbox image by digest** in a module covered by the installed-byte
manifest, runs the device container from that digest, and refuses to bind unless the container's
image is the pinned one (§3.1). The four host steps then run with the **image's** interpreter
instead of the host's: A probes the interpreter inside the pinned image (§3.2); B, C and D run their
unchanged helpers in short-lived **trusted helper containers** started from the same pinned digest,
with no network, a read-only root, no capabilities, and exactly the host paths they need mounted at
the **same absolute paths** (§3.3). The helpers keep their descriptor-relative, no-follow logic and
the host paths they already compute, so the code change is in how they are launched, not what they
do; and a planted link can now reach only what the helper container mounts, never the rest of the
host. A docker-mode machine then needs only Docker and the program; `hostPythonProblem` leaves the
docker paths of login and start. No kernel, SDK, protocol or plugin contract change.

## 3. Details

### 3.1 The pinned image and its attestation

- A new helper module `packages/device/src/exec/docker-image.ts` (added to `HELPER_MODULES` in
  `runtime-manifest.ts`, so its bytes are part of the attested `helperHash`) holds:

  ```ts
  export const SANDBOX_IMAGE_PIN = {
    repository: "ghcr.io/capybara-hq/capybara-sandbox",
    version: "0.1.0-rc.NN",          // display and pull logs only
    index: "sha256:…",               // the multi-arch index digest
    platforms: {
      amd64: { manifest: "sha256:…", config: "sha256:…" },
      arm64: { manifest: "sha256:…", config: "sha256:…" },
    },
  } as const;
  ```

  `docker.ts`'s `SANDBOX_IMAGE` becomes `${repository}@${index}`: every `docker run` (device
  container and helper containers) names the digest, never a tag. The registry and the tag are
  untrusted; only content addressing counts.
- **Attestation at bind.** `verify` (`staged-device.ts`) already reads the running container's image
  id. It now also `docker image inspect`s it and accepts only when the id is the pinned `config`
  digest of the host's architecture (classic image store) or the pinned `index` / `manifest`
  digest (containerd image store, the default of fresh Docker 29 / Docker Desktop installs, where
  the image id is the index digest). Anything else throws `RuntimeManifestError`: no runtime
  identity, nothing attested, nothing admitted (fail closed, the same path as a changed install).
  A host architecture without a pinned platform refuses docker mode at login and start with a
  readable message.
- Because the run flags now carry the digest, a container made from the old tag has another spec
  label and is recreated, once idle, by the existing `ensureContainer` path (files kept on the host
  mounts).
- **Producing the pin.** `pnpm gen:device-image-pin <version>` (tools, not shipped) reads
  `docker buildx imagetools inspect --raw` for the published version and writes the module. A
  check (`check:device-image-pin`) verifies the module's shape offline on every PR; the network
  half (the pinned digests resolve in the registry and match) runs in the release workflow before
  `@capybara-hq/device` is published, so a pin that does not exist is never released (§6, item 3).

### 3.2 Step A: the environment fingerprint in docker mode

`EnvironmentInputs` gains `place: "host" | "image"`. For `"image"` (docker mode),
`collectEnvironment`:

- takes the interpreter facts from the same `PYTHON_PROBE` run in a helper container (§3.3) as
  `/usr/bin/python3 -I -c …`: executable, version, and the files the helpers' imports load, each
  with its sha256 computed by the probe (the image is pinned, so these are consistency facts, not
  the root of trust);
- takes the shell facts from the image too (`/bin/bash` in the image), so the host needs no
  `/bin/bash` either;
- keeps the Node facts (the program itself runs on the host with that Node);
- records `providerImageDigest` as the pinned index digest (constant per program version and
  architecture), and `place` in `environmentBoundaryDigest`.

`canonicalEnvironment` bumps its leading version to `2` for both places (before 0.1.0: no
compatibility with version 1). OS mode keeps probing the host interpreter exactly as today.

### 3.3 Steps B, C, D: trusted helper containers

A small launcher, `helperContainer(...)` in `docker-operations.ts`, replaces the host `spawn` /
`spawnSync` of the interpreter for these steps:

```
docker run --rm -i --name capybara-helper-<deviceId>-<random> \
  --label capybara.device.helper=<deviceId> \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --user <containerUser()> --entrypoint /usr/bin/python3 \
  --mount type=bind,source=<P>,target=<P>   (one per path the step needs, same absolute path) \
  <repository>@<index> -I -c <helper source> [args]
```

- **Same absolute paths.** Each mount maps a host path to the identical path in the helper
  container, so the helpers keep the host paths they already compute (`hostPathOf`, the spool's
  `privateRoot`, the artifact root, the pinned skills roots) and their protocol is unchanged.
  Descriptor-relative walks resolve inside the helper container: a link planted in the workspace
  that points at `/etc` or `~/.ssh` reaches the helper container's read-only root (or nothing),
  never the host. This is stronger than today, where the same helper ran with the host's whole file
  system behind it.
- **What each step mounts.** B: the device's host `skills` directory, read-write. C: the program's
  spool directory under the state directory and the artifact's host mount root (`workspace` or
  `tmp`), read-write. D: the spool directory only. Nothing else of the host, never the state
  directory as a whole, never the home.
- **Lifetimes.** B and D are one-shot (`spawnSync` becomes a run to completion). C lives as long as
  its spool, like today's child: stdin open = alive; EOF (the program exiting or crashing) ends the
  helper and `--rm` removes the container. At start the program removes leftover helper containers
  of its devices (by label; they hold nothing the journal relies on, since the spool's durable
  state is on the host disk and D re-verifies it).
- **Why not the device container.** Running B to D with `docker exec` in the long-lived device
  container would avoid a container start, but that container runs untrusted work as the same uid
  on Linux. B would need a writable skills mount there (an escalated call could then rewrite
  skills, which today it cannot), and C would need the state directory mounted there (the retained
  output's authority would become writable by the work it records). A separate helper container
  keeps both out of the device container's reach.
- **Interpreter and sources.** The interpreter is the pinned image's `/usr/bin/python3`; the helper
  sources still come inline from the verified program (`inline/native-files.py`,
  `inline/output-spool-helper.py`, ...), never from the image (`/opt/capybara-runtime` in the image
  belongs to the cloud providers and is not used here).
- **Ownership checks.** The helpers check that what they open is owned by their own uid
  (`st_uid == os.getuid()`). On Linux the helper runs as the host uid:gid, as the device container
  does. On macOS Docker Desktop's file sharing presents bind-mounted files as owned by the
  accessing container user; the helper runs as the image's `sandbox` user like the device
  container. Both are covered by tests (§4); if Docker Desktop's mapping fails the check, the step
  fails closed with a readable error rather than skipping the check.

### 3.4 Trust boundary

| | Trusted | Attested / checked by |
|---|---|---|
| The program's installed bytes (incl. the helper sources and the image pin) | yes | the shipped manifest (`runtimeHash`, `helperHash`) at every bind |
| Node running the program | yes | the environment fingerprint |
| The Docker daemon and CLI | yes (as today: it starts the device container and owns its mounts; control of the daemon is root on the host) | not attested; out of scope |
| The sandbox image content | yes, **only at the pinned digest** | content addressing + the bind-time image check (§3.1) |
| The image's interpreter | yes, as part of the pinned image | the in-image probe in the fingerprint (§3.2) |
| Registry, tag, mirror | no | nothing taken from them except bytes that match the digest |
| Anything the device container runs, sandboxed or escalated, and anything it writes (workspace, tmp) | no | helpers treat those trees as hostile: descriptor-relative, no-follow, inside a helper container |
| Host python3, host `/bin/bash` | not used in docker mode | — |

What changes compared with today: the host interpreter is trusted by its location (root-owned
`/usr/bin`) and fingerprinted; after the change no host interpreter is involved, and the interpreter
that runs the trusted helpers and the operation agent is fixed by the program version through the
digest instead of whatever the tag currently names. The device container's own guarantees
(read-only root, no capabilities, mounts) are unchanged.

### 3.5 How the device package and the image cooperate

The image is built and published by the plugins repository; the device package consumes a released
version by digest. The image's contract with the local device (to be added to the Dockerfile's
contract comment in a plugins PR, alongside the existing list/scan line):

- `/usr/bin/python3` at that path, standard library only, with every module the device helpers
  import (`pythonImports` of the inline sources; the probe fails closed when one is missing);
- `/bin/bash`, `sleep` (the device container's entrypoint) and the tools the agent already needs;
- runs under an arbitrary uid:gid with a read-only root file system and no capabilities;
- no reliance on `ENTRYPOINT` / `CMD` (the device sets `--entrypoint`).

Bumping the image is a core PR: regenerate the pin, which changes `helperHash`, so every device
re-binds on upgrade, as with any program upgrade. The pinned version no longer has to match the
plugins' device-docker version (today `SANDBOX_IMAGE_TAG` is `0.1.0-rc.5`).

### 3.6 Migration

- **Program upgrade.** The first start of the new version re-verifies (new manifest, version-2
  environment), recreates the device container from the digest once idle (files kept), and binds
  with a new runtime identity. The kernel sees a changed runtime, as for every program upgrade; no
  kernel or protocol change.
- **The #704 check.** `hostPythonProblem` is no longer called for docker mode in `login` and
  `start`; the `host_python_missing` code and the README paragraph go (before 0.1.0: removed, not
  deprecated). OS mode keeps using the host interpreter (out of scope; §6, item 5).
- **Pull.** The first docker-mode start pulls `repository@index` (a large image, as today). A pull
  failure is the existing readable "creating the container failed" error.
- **Offline / air-gapped.** A digest-preserving mirror (`crane copy`, `docker buildx imagetools
  create`) keeps the digest; `CAPYBARA_DEVICE_IMAGE_REPOSITORY` points the repository part at it (§6, item 2).
- **Desktop client.** It runs the same device package; nothing to change beyond the version bump.

## 4. Tests

Following the test-portfolio rules (unit tests need no Docker; Docker-gated tests are skipped
without it; new unit tests join their checked-in list).

- **Unit (packages/device).**
  - Login and start in docker mode succeed with `isExecutable` answering false for every path (no
    host python3) and still refuse in OS mode where they did before.
  - Image check: accepts the pinned config digest (classic store) and the index / manifest digest
    (containerd store) for the host architecture; refuses another digest, a missing platform, a tag;
    the refusal yields no runtime identity.
  - `helperContainer` argv: digest reference, `--network none`, `--read-only`, `--cap-drop ALL`,
    `no-new-privileges`, `--user`, label, exactly the step's mounts at identical paths, nothing
    else; a path with a comma (the `--mount` separator) is refused, as for the device container.
  - Environment version 2: docker mode takes interpreter and shell facts from the probe runner
    (faked) and never touches the host interpreter; OS mode unchanged.
  - `check:device-image-pin` has a violating fixture that makes it fail (a tag instead of a digest,
    a missing platform, a malformed digest).
- **Docker-gated (packages/device, real Docker, `pythonPath` pointing at a path that does not
  exist).**
  - Bind, exec, a background task with an artifact, skills preparation, then a program restart
    that recovers the output (D): all succeed without a host interpreter.
  - The existing symlink cases of the spool and the native helper, run through helper containers: a
    link in the workspace at the artifact path or in a skills root pointing at a host path outside
    the mounts is refused or lands inside the helper container, and the host path is unchanged.
  - A device container made from another image (built locally with a different digest) does not
    bind and is recreated from the pinned digest.
  - Leftover helper containers (killed program) are removed at start.
- **macOS Docker Desktop.** The ownership check (§3.3) and the identical-path mounts of the state
  directory are verified by hand on a Mac before the release (no macOS Docker runner in CI).

## 5. Rollout

1. Core PR: `docker-image.ts` + pin tooling + `check:device-image-pin` + release-workflow network
   check; the device container runs by digest; bind-time image check.
2. Core PR: helper containers for B, C, D; environment version 2; remove the docker-mode host
   check, its error code and README text. Changeset bumping `@capybara-hq/device`.
3. Plugins PR: the sandbox Dockerfile's contract comment gains the local-device lines (§3.5).

## 6. Decisions (formerly open questions)

The maintainer approved every recommendation on 2026-11-23.

1. **Helper containers vs. a writable root-only mount in the device container.** Decided
   2026-11-23: helper containers (§3.3) for skills preparation (B), the background output spool (C)
   and recovered-output finalization (D): `--network none`, a read-only root, `--cap-drop ALL`,
   `no-new-privileges`, and same-path mounts of only the step's host paths. The rejected
   alternative (a writable root-only mount in the device container written with `docker exec -u 0`)
   cannot write the host user's files on Linux without capabilities, and same-uid access would put
   skills and the retained output in reach of escalated calls.
2. **Mirrors and custom registries.** Decided 2026-11-23: an optional
   `CAPYBARA_DEVICE_IMAGE_REPOSITORY` overrides the repository only; the digest stays pinned, so a
   mirror must preserve it. There is no override of the digest (a custom image is a different,
   unattested runtime).
3. **Where the pin's network check runs.** Decided 2026-11-23: in the release workflow before
   `@capybara-hq/device` is published, and on PRs that touch the pin file; never on every PR
   (network-dependent). Every PR runs the offline shape check `check:device-image-pin`.
4. **Background task cost.** Decided 2026-11-23: accept one helper container per live background
   task (C) and a container start per skills preparation (B); revisit with a per-device long-lived
   helper only if measurements show a problem.
5. **OS mode on Linux.** Decided 2026-11-23: out of scope; the host transport keeps the host
   `/usr/bin/python3`. A shipped interpreter, if wanted, is a separate design.
6. **Containerd image store id.** Decided 2026-11-23: accept the pinned index, per-arch manifest or
   config digest, log which one matched, and fail closed on anything else, so a Docker change in
   how image ids are reported fails closed instead of silently passing.

## AGENTS.md rules touched

- **Dependency direction** (`device` -> `plugin-sdk` only): unchanged; no new package dependency,
  the pin tooling lives in `tools/`. `pnpm check:deps` keeps passing.
- **Sandboxes** ("the provider decides how operations are confined", "minimal environment", "private
  ranges, metadata and host services stay closed"): the device container's confinement is
  unchanged; the new helper containers run trusted code only, with `--network none`, a read-only
  root, no capabilities and only the mounts their step needs. Command review, approvals and
  escalation are untouched.
- **Tests**: unit tests need no Docker; Docker-gated tests are skipped without it; new tests join
  their checked-in lists; the new check has a violating fixture (proven red first).
- **When a rule can be checked automatically, the check is the authority**: `check:device-image-pin`
  (offline shape) is added to `tools/checks/README.md`, stating it runs in full on PRs (it reads one
  file) and why.
- **Before 0.1.0**: the environment fingerprint format and the `host_python_missing` code change
  directly, with no compatibility layer.
- **Public API reports**: none; no SDK or plugin-client API changes. The implementation PRs carry a
  changeset bumping `@capybara-hq/device`.
- **Multi-replica discipline**: not touched; the device program is one process per machine and the
  kernel is unchanged.
- **Language**: English throughout; model-facing text is unchanged.
