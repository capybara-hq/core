# In-place network allowlist update for `device-docker`

Issue: #663 (last item). Status: draft for review. Written against core `main` at `87345db65` and
plugins `main` at `1c9b0dd` (last `plugins/device-docker` commit `80a489e`, version
`0.1.0-rc.23`).

Related: device provider spec §6.3 (`2026-11-21-device-provider-design.md`, a host added to a list
reaches the instance at its next use); auto mode spec §4.2 (`update`, `limitsApplyAt`); the
writing-device-providers skill ("Limits and the device sandbox network", "Cloud installed evidence").

## 1. Problem, and what is true today

The issue says widening an org or platform host list "updates or recreates each allowlist instance
once at its next use (Docker without update stops background processes)". Reading the code, the
picture is narrower than that:

- **Kernel.** `SandboxService.mustApply` sends a running (or just resumed) cloud instance through
  `applyLimits` under the exclusive lease when its recorded network kind differs, when it allows a
  host the desired list does not cover (`appliedWider`) or when it lacks a desired host
  (`appliedLacksHost`). `applyLimits` calls `update`; `"updated"` records the new limits and keeps the
  instance; `"recreate"`, a gone instance or a failed `update` destroys the instance and creates one
  on the same files, which ends every process in it (background tasks included) and posts the
  "recreated" notice.
- **device-docker.** Each instance is a sandbox container, an internal network and an egress proxy
  container (`egress-proxy/proxy.mjs`, HTTP CONNECT + SOCKS on the internal network, allowlist from
  env `ALLOW_HOSTS`, every resolved address checked against the closed classes). The sandbox
  container has no other route out. `update` already exists: when `updateDecision` finds that the new
  list keeps every host recorded in the sandbox container's labels (or open-public to open-public),
  it **deletes and recreates the egress proxy container** with the new env and answers `"updated"`.
  The sandbox container and its processes stay.

So a plain widening of a non-empty allowlist already keeps background processes. What still hurts:

1. **The proxy swap is not in place.** Every open connection through the old proxy ends (a
   `git clone`, a package download, a long-poll in a background dev server). There is a gap between
   delete and ready where new connections fail. The new proxy has a new IP behind the same name, so
   a process that cached the old address (the JVM caches lookups by default) loses the network until
   it restarts.
2. **Every narrowing recreates the container**, a host removed from the platform or org list
   included. `updateDecision` answers `"recreate"` for fewer hosts because the sandbox labels are the
   lower bound a lost proxy is rebuilt from.
3. **A failed swap recreates the container** (the kernel's fallback for instance-bound providers).
4. **Kind changes recreate the container**: `open-public` <-> `allowlist`, and an empty allowlist
   (`NetworkMode: none`, no proxy) <-> a non-empty one, so the first host added to an empty list
   recreates.

This design removes 1 to 3 for allowlist-to-allowlist changes and leaves 4 as an open question.

## 2. Decision in one paragraph

The egress proxy gets a **control socket** and a **per-instance config volume**. `update` for an
allowlist-to-allowlist change (wider, narrower or both) runs `docker exec` in the proxy container
with a small control client that hands the proxy the new list; the proxy writes it to its config
volume, swaps its in-memory list atomically, **closes every open tunnel to a host the new list no
longer covers**, and only then acknowledges with the list's digest. `update` answers `"updated"` only
on that acknowledgement. The proxy keeps its container, IP and every connection the new list still
allows; the sandbox container is never touched. Any failure throws, and the kernel's existing
fallback recreates the instance (fail closed). No kernel or SDK contract change is needed; the SDK
doc of `update` gains the narrowing rule (§3.3).

## 3. Details

### 3.1 Proxy (plugins `device-docker/egress-proxy`)

- **Config volume** `<name>-egress-conf`, mounted only in the proxy at `/config` (the proxy rootfs
  stays read-only; the image creates `/config` owned by `node` so the named volume inherits it). It
  holds `allow.json` = `{ mode, hosts, digest }`. At start the proxy reads it when present and valid,
  else the env (`MODE`, `ALLOW_HOSTS`) as today. The volume belongs to the instance: `destroy` /
  `destroyByName` remove it with the containers and the internal network, and `destroyFileSystem`
  never touches it. This is a deliberate exception to "drops the instance … (never volumes)"; the
  provider comment on `destroyByName` changes to "never the file system's volumes".
- **Control socket** at `/run/egress/control.sock` on a tmpfs
  (`HostConfig.Tmpfs: { "/run/egress": "rw,noexec,nosuid,size=64k,uid=1000,gid=1000,mode=0700" }`,
  uid 1000 = the image's `node` user; the socket itself mode `0600`), a Unix socket only processes
  in the proxy container reach. The sandbox reaches the proxy only on TCP 3128 / 1080 over the internal
  network, so it cannot change its own list. The client is a mode of the same file
  (`node /app/proxy.mjs control apply <json>`), started by `update` through the Docker exec API with
  `User: "node"` (the socket proxy already allows exec, the sandbox uses it).
- **Apply**: validate every host with the same rules as `ALLOW_HOSTS` (refuse the whole request on
  one bad entry); write `allow.json` (temp file, fsync, rename); replace the list reference used by
  `hostAllowed` (single-threaded, so a check sees the old or the new list, never a mix); walk the
  registry of connections and destroy both sockets of every entry the new list does not cover; then
  reply `{ ok, digest }`.
- **Connection registry.** An entry is registered when a request is admitted by host, **before**
  name resolution, and removed when both sockets close. It covers CONNECT tunnels, SOCKS (from the
  moment the handshake names a target, through resolution and `connectAny`, up to
  `CONNECT_TIMEOUT_MS`), and absolute-URL HTTP requests in flight. Each entry records the normalized
  target host. On apply every entry is re-evaluated with `hostAllowed(host, newList)` (wildcards
  included, never string equality with the old list's entries). A connection still resolving or
  connecting re-checks `hostAllowed` against the current list when its upstream connect completes
  and drops the socket if the host is no longer covered, so no admission made under the old list
  outlives the swap. A request with the digest already in force replies at once
  (idempotent).
- Only allowlist to allowlist with a non-empty list is applied this way. `open-public` and the mode
  stay as today (§1 item 4).

### 3.2 Provider (`device-docker/src/provider.ts`)

- `update`: unchanged decisions for `none`, kind changes, a missing container and a container
  without this contract's labels (`"recreate"`). For allowlist to allowlist: when the sandbox container
  and its proxy carry the control label (`dev.capybara.sandbox.egress-control: 1`), apply in place
  (§3.1); a suspended instance has its proxy started for the call and stopped again, so the volume
  holds the new list for the next resume. An instance without the label (made by an earlier plugin
  version) gets today's swap for a widening; a narrowing there answers `"recreate"` as today.
- **Lower bound invariant.** A rebuilt proxy never allows more than the list last acknowledged.
  The sandbox labels keep the list of `create`, which after an in-place narrowing is **wider** than
  in force, so they are a valid source only for an instance that has never been updated in place.
  The sandbox container gets the label `dev.capybara.sandbox.egress-control: 1` at `create` (labels
  cannot change later, so it is set on every instance this version creates). A lost proxy is
  rebuilt from the config volume when it exists (exactly the list in force). When the volume is
  missing too, `ensureEgressRunning` rebuilds from the labels **only** for a container without the
  control label; for one with it, it returns `false` (like `ensureInternalNetwork` does for an old
  internal network), so `resume` answers `gone` and `update` answers `"recreate"`, and the kernel
  recreates the instance under the desired limits. A missing volume never falls back to the labels.
- **Acknowledgement.** `update` answers `"updated"` only when the exec exits 0 and prints the digest
  of the list it sent. A non-zero exit, a timeout, a wrong digest or an abort throws.

### 3.3 Security rule (narrowing)

A provider answers `"updated"` for a narrowing only once no connection to a removed host survives
and no new one can open. Otherwise it answers `"recreate"` or throws. The SDK doc of
`DeviceProvider.update` states this for every provider (device-e2b included), and the core skill and
the device-docker README repeat it. When a narrowing applies is unchanged (the kernel's next use
or reconcile, under the lease); the rule constrains only a successful `"updated"`. A failed or
aborted `update` is the kernel's to handle (recreate, or quarantine and retry on the next use).

### 3.4 Failure handling

- `update` throws: the kernel recreates the instance (instance-bound provider), which removes the
  proxy and its volume; the new instance gets the desired list at `create`. On abort the kernel
  quarantines (suspends) the instance and rethrows; the next use resumes and calls `update` again,
  which is idempotent by digest.
- Crash between the file write and the swap: the proxy restarts from `allow.json`. For a narrowing
  the file is the narrower list (safe). For a widening the proxy may now run the wider list while the
  kernel record is the older one; the record then claims less than is in force only for hosts the
  desired limits already allowed. On the next use `appliedLacksHost(record, desired)` is still true,
  so the kernel calls `update` again, which acknowledges at once by digest and records the list; a
  later narrowing goes through `applyLimits` because `appliedWider` sees the difference.

### 3.5 Records, reports and approvals

- The kernel records the new `instance_limits` on `"updated"` as today. The cloud evidence identity
  includes the recorded applied limits, so the evidence becomes stale and is read again under the
  lease (existing behavior).
- No "recreated" notice for these changes any more. The device view's `pendingNextUse` text stays
  correct ("applies at next use").
- Host grants with `always` / `next-use` on Docker now apply without a restart. No change to
  `perOperationHosts` (still false for Docker: the proxy is per instance, not per operation).

### 3.6 Multi-replica

`update` runs under the kernel's exclusive device lease, so one replica applies at a time. The plugin
keeps no in-process state: the list in force lives in the proxy container and its volume, the
request is idempotent by digest, and a replica that loses the lease mid-call leaves either list in
force, both within what the kernel recorded or desired (§3.4).

## 4. Tests

- **Proxy unit** (`test/egress-proxy*.test.ts`): control request validation; swap; a widening keeps
  open tunnels; a narrowing closes tunnels (CONNECT, SOCKS, HTTP forward) to removed hosts and keeps
  the others; restart reads `allow.json`; idempotent digest.
- **Docker integration** (`test/network.test.ts`, real Docker): a background process holding a
  connection survives a widening and the container id is unchanged; a narrowing closes the
  connection to the removed host, keeps the container and refuses new connections to it; suspend and
  resume keep the updated list; a lost proxy is rebuilt from the volume; **proxy lost, volume lost,
  narrowed instance**: resume answers `gone` and `update` answers `"recreate"` (never a proxy
  rebuilt from the wider labels); a connection still resolving or connecting to a removed host when
  the narrowing lands is dropped; `destroy` removes `<name>-egress-conf`; a control failure throws.
- **Kernel**: no behavior change. One `device-fake` test that `"updated"` keeps a running background
  task and posts no "recreated" notice, if not already covered.

## 5. Rollout

1. Plugins: `device-docker` and the egress image (both carry the plugin version tag), README
   (`update` row, "Network and egress"), changeset; release.
2. Core: bump the `device-docker` pin in `packages/kernel/bootstrap.json`; fix the stale skill line
   that says host changes reach only new instances; SDK doc of `update` (§3.3) with `gen:sdk-api` and
   a changeset if the report changes.
3. Existing instances keep working: they lack the control label and use today's paths, so a
   widening on an old instance still drops its open connections (once per change) and a narrowing
   still recreates it; the recreate gives it a container and proxy of this version. No migration.

## 6. Open questions for the maintainer

1. **Narrowing in place** (recommended) or keep narrowing as a recreate and do widening only? In
   place is safe only with the lower bound invariant of §3.2 (a missing config volume recreates
   instead of rebuilding from the wider labels) and a complete connection registry (§3.1); the tests
   in §4 are the proof.
2. **Kind changes** (`open-public` <-> `allowlist`): keep recreating (recommended: the labels name the
   kind for `refuseOpenNetwork` on resume), or move them in place too?
3. **Empty allowlist**: today `NetworkMode: none`, so the first host added recreates. Give every
   allowlist instance an internal network and a proxy with an empty list instead? Fewer recreates,
   but the kill switch becomes "the proxy refuses everything" instead of "no network".
4. Should the same control also refresh `deniedCidrs`, which today reaches only proxies created
   afterwards?

## AGENTS.md rules touched

None changed. Rules this design relies on:

- **Sandboxes**: every provider enforces allowlists; private ranges, metadata and host services stay
  closed (the proxy's address checks are unchanged; the control socket is not reachable from the
  sandbox); the network is one kernel setting per device, applied by the kernel under its lease.
- **Multi-replica discipline**: no in-process state; the list in force lives in the proxy container
  and its volume, and the kernel's exclusive lease serializes `update` (§3.6).
- **Extensions**: in-process plugin code only through `ctx` and the SDK; no SDK signature change
  (only the `update` doc, §3.3; `gen:sdk-api` and a changeset if the report changes).
- **Before 0.1.0**: no compatibility layer; proxies of the previous version take the existing swap
  path once, which is the current behavior, not a shim.
