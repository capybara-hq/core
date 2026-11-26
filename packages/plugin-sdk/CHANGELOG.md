# @capybara-hq/plugin-sdk

## 0.1.0-rc.79

### Patch Changes

- 489b49b: The SDK's current `native-files.py` answers a read or write of a FIFO, device or other special file
  with `NOT_REGULAR_FILE` (a `NotRegularFile` error), mapped by `nativeFailureText` (core#907). Step 1
  of the runtime change: `SANDBOX_RUNTIME_SOURCE.files` keeps the staged helper byte for byte
  (`sandbox-native-staged-runtime-source.ts`), `current` and `accepted` carry the new digest.
  capybara-device, which always runs `current`, recognizes the error by its class.

## 0.1.0-rc.78

### Patch Changes

- bd6dd67: A `/name` skill invocation renders `${CLAUDE_SKILL_DIR}` and its files line under the conversation
  device's skills root (`renderSkillInvocation`'s new `skillsRoot`), not always `/skills`; `Skill`
  after an inline invocation copies the files without repeating the instructions (#904).
- 506de30: A failed native file operation names its cause (#907): the SDK's `nativeFailureText(code)` maps a
  native helper's error code (`NOT_REGULAR_FILE`, `ENOENT`, `ENOTDIR`, `EISDIR`, `ENOSPC`, …) to
  actionable English text, keeping the generic text for unknown codes. capybara-device's native
  helpers answer `NOT_REGULAR_FILE` for a read or write of a FIFO, device or other special file, and
  its macOS and Linux operation backends throw the mapped text instead of one generic message.

## 0.1.0-rc.77

### Minor Changes

- 70d42b5: `identity-source@1` sources may declare `tenant` (label, help, pattern, placeholder, `neverTrusted`)
  so the admin console can label and check trusted tenants; `validateTenantId` applies the rule.
- 6984d37: Refused network hosts carry the layer that refused them end to end.
  
  - SDK: `ctx.deviceAccess.reportBlockedHosts(call, hosts)` takes `ServiceBlockedHost[]`
    (`{ host, layer }`) instead of host names, and `sandboxProxyRefusalLayer(reason)` reads the layer
    from the device sandbox proxy's refusal reason (a closed address is `address`, a host off the
    allowlist `device`).
  - Kernel: a device service's refused host gets the note of its layer: a host refused for its
    private or local address gets the address note, never a network ask or the "an organization
    admin adds it" note. A host reported twice keeps its most restrictive layer, and an IP literal is
    always `address`, so a report never makes a host grantable.
  - capybara-device: a restricted command on macOS reports the hosts its operation proxy refused
    (`network.blocked`, which the protocol 2 removal had left unwired), so a sandboxed `curl` to a
    name resolving to a private address gets the address note instead of nothing.

### Patch Changes

- e0a320f: Device service rolls (an extension upgraded while its service runs), follow-ups:
  `deviceServiceFilesDigest` caches per files object, and `DEVICE_SERVICE_FILES_DIGEST_VECTOR` pins the
  digest for every implementation (capybara-device now uses the SDK's). The kernel never rolls a
  service to the files of a draining instance, of another package than the replica runs or than the
  deployment enabled, and keeps a service that answers the new roll check (`DEVICE_SERVICE_ROLL_CHECK`,
  `parseRollCheck`, `isRollCheck`) busy. A provider that keeps the old files after the start is
  refused with the cause instead of every later call being reviewed again. The
  `device.service_started` audit row says `reason` (`start` or `files_changed`), the files digest and
  what a roll replaced, and a call that finds the row of the same start writes none.
  A busy answer holds a roll onto the same files for at most an hour, and the holds apply at the
  re-check after the review too.

## 0.1.0-rc.76

### Patch Changes

- 449d337: A device service keeps running after its extension is upgraded no longer: the provider reports the
  files a running service was started from (`DeviceServiceStatus.filesDigest`, the new
  `deviceServiceFilesDigest`), and `ctx.deviceAccess.ensureService` treats a service running other
  files like a stopped one: the start is reviewed, then the provider restarts it on the new files.
  capybara-device restarts a running service whose ensure names other files (its `filesDigest`, or
  the digest of the files sent) and reports the digest in its status. Providers that report no digest
  keep the old behaviour; device-local passes it through from its next release.

## 0.1.0-rc.75

### Minor Changes

- 016a74a: Questions can be answered with buttons. `InputForm` gains `body` (longer text under a short title)
  and, on its single field, `choices` (labelled values). When that field is required and a single
  choice (a `boolean`, or a string `enum` without `multiSelect` / `allowOther`), it renders as one
  button per choice, the first primary, and pressing one answers at once. Examples are a confirm
  (完成 / 取消) and a one-value wait (结束等待). `validateInputForm` checks the rule, and the
  kernel keeps `body` and `choices` in `question_asked`. The conversation's question card shows the
  body. When the plugin tool's `InputRequired` names a panel (`open`), the card also offers an action
  that opens that panel.

### Patch Changes

- de210cf: Browser tabs owned per conversation, core part. `ToolCallContext.rootConversationId` gives every
  tool handler the root of its conversation tree (set by the kernel). A viewer stream on a device
  service now starts with a kernel-written viewer context message (`DeviceServiceViewerContext`,
  `encodeViewerContext`, `parseViewerContext`: the ticket's conversation and its root); a later
  `{"kind":"viewer"}` from the panel is never context. `ctx.deviceAccess.answerHandoff` takes
  `handoffConversationId` and answers a sub-agent's handoff from the root's panel, only within the
  scope conversation's tree. `@capybara-hq/testing`: `FakeDialInMachine.streamOpenGate` holds a
  `stream-open` answer for ordering tests. During a rolling upgrade, viewer tickets minted by an older
  replica are refused (a ticket lives 60 s; reopen the panel).
  The browser plugin's panel Done / Cancel needs the browser release that passes
  `handoffConversationId`; upgrade both together.

## 0.1.0-rc.74

### Patch Changes

- 1cd5adb: A device service on macOS may register and look up Chromium's rendezvous server
  (`com.google.chrome.for.testing.MachPortRendezvousServer.*`), so the full Chromium build starts under the local sandbox
  (core#843); the profile's app-shim listener (`…apps.*`) stays closed. The launcher tells the service with
  `CAPYBARA_SERVICE_MACH=chromium` (`DEVICE_SERVICE_MACH_ENV`, `DEVICE_SERVICE_MACH_CHROMIUM`). Agent commands get none of it;
  the service's file and network confinement is unchanged. The bundled sandbox runtime patch gains `allowMachRegister` (names
  of at least three dotted labels).

## 0.1.0-rc.73

### Patch Changes

- aa535be: Images in tool results reach the agent and the person. The pipeline stores every image block a
  tool returns (a browser screenshot, an MCP image) as a copy of the conversation and names it in the
  result (`file_id`); a model with vision sees it after the step's results, a model without vision is
  told it was not shown and how to read it, and an image that cannot be stored says why. The web
  shows the images as thumbnails on the call's row (opening the image viewer), and `Deliver` takes a
  `file_id` to hand such an image (or any attachment or artifact of the conversation) to the person
  without a device.

## 0.1.0-rc.72

### Minor Changes

- e2ca2ff: A device's first tool call no longer hangs in silence until the tool's time limit:
  
  - `ToolSpec.timeoutMs`: an extension tool can declare its own time limit, from 1 s to 10 min
    (`TOOL_TIMEOUT_MIN_MS`, `TOOL_TIMEOUT_MAX_MS`). It replaces `tools.timeoutMs` for that tool and is
    cut to the new deployment setting `tools.maxTimeoutMs` (default 10 min). It is not part of the
    tool's definition fingerprint.
  - A tool call that times out while `ctx.deviceAccess.ensureService` is still starting the device,
    before the call sent anything to a device service, says that the device was still starting and
    nothing reached the target. It no longer uses the generic "may or may not have completed" text.
  - The dial-in relay adds the reconnect grace only while the machine is disconnected. A connected
    machine is given up at the deadline plus a margin (at least the device lease TTL). It fails with
    `DeviceRequestNotSentError` when the request was never taken, and with the new SDK error
    `DialInAnswerTimeoutError` (`isDialInAnswerTimeoutError`, code `device.answer_timeout`) when the
    outcome is unknown. Tools show the outcome-unknown text for it. A slow machine is never reported
    as a refused open network or a failed create. `capybara-device` now answers an expired lifecycle or operation
    request with a typed `unknown` error instead of staying silent.
  - The sandbox logs each lifecycle step (resume, create, recreate) with its duration and outcome.
    It also logs relay give-ups and aborted lease or relay waits.
  - A device service launch is reviewed by its own rule, `allow.service` ("Starts a device service
    declared by the extension, from its code directory."), instead of `allow.dev`.
- 5a8031d: Dial-in stream data can travel as binary WebSocket messages. A machine's hello offers `transport.binaryStreamData` and the kernel's `ready` agrees; from then on both sides send `stream-data` as one binary message (`encodeDialInStreamData`: tag, stream id, the raw bytes) instead of base64 inside JSON, which cuts a quarter of the bytes of every device stream (the browser live view). `capybara-device` offers it; a machine that does not offer it stays on JSON, and a `capybara-device` whose offer an older kernel refuses (4400 before `ready`) reconnects without it, so the device and the deployment can be upgraded in either order. `FakeDialInMachine` takes `binaryStreamData` to test both.
- 7a178bf: The conversation's right panel keeps an embed mounted across full mode: maximising or restoring
  the panel no longer reloads its iframe, so a panel's document and connections survive the switch,
  and a panel embed fills the panel (borderless) in both modes instead of sizing itself by `resize`.
  The embed bridge tells a `conversation.panel` embed the panel's mode: `EmbedParentMessage` gains
  `panel-mode { full }`, sent right after `init` and on every change, whoever made it (the embed's
  own ask, the close control or Esc, the host refusing full mode on a phone). A plugin tool's
  `InputRequired` may carry `open` (a `UiOpen` naming a `conversation.panel` of the same extension):
  the kernel writes it to `question_asked` after checking it, and the conversation page opens that
  panel when the question arrives.

### Patch Changes

- c9a563b: Device services are namespaced per extension (core#817): a device provider now receives every service
  by its id `<extension>.<name>` (`DEVICE_SERVICE_ID_RE`, `deviceServiceId`) in `ensureService`,
  `stopService`, `serviceStatus`, `serviceRequest` and `openStream`, never by the extension's bare name,
  so two extensions declaring the same service name never start, stop or reach each other's process.
  `ctx.deviceAccess` keeps the extension's own names and maps statuses back. `capybara-device` accepts
  service ids only (a machine on an older version refuses them: update it with the deployment), and the
  device service conformance starts `conformance.echo`.
- c9a563b: `capybara-device` gives every device service an install directory (`<device dir>/svc-install/<id>`,
  named by `CAPYBARA_SERVICE_INSTALL`, `DEVICE_SERVICE_INSTALL_ENV`): the service may write it until it
  creates the regular file `.sealed` there (`DEVICE_SERVICE_INSTALL_SEAL`), and from its next start on
  reads it only, so nothing the service later runs can replace what it installed (the browser plugin's
  Chromium, capybara-hq/plugins#209). It is emptied at every start that does not find it sealed under the service's current files, and
  agent operations can neither read nor write it.
  Entries of `svc/` and `svc-files/` kept under bare service names from before ids (an old browser profile) are removed at the
  next service start: the person signs in to sites in the browser again once.

## 0.1.0-rc.71

### Minor Changes

- b93ea83: `file-preview@1` previews skill files: `FilePreviewArgs` gains `FilePreviewSkillArgs` (`source:
  "skill"`, with `orgId`, `accountId`, `skillId`, `version` and `path`; `file.id` is
  `<skillId>@<version>/<path>`), and an org embed token for a skill file's previewer carries
  `OrgEmbedClaims.skillFile` (`{ skillId, version, path }`, never with a conversation, agent or file
  id); an extension's `embed` route sees it as `RouteCaller.skillFile` on an org caller. A previewer
  that matches by type needs no change.

## 0.1.0-rc.70

### Patch Changes

- 1969e4a: Device providers may implement `serviceStatus(h, name, signal)`: a device service's state without
  starting it. `ensureService` takes `opts.ifRunning`: it reads only the name (the kernel sends a
  name-only spec), never starts a stopped service, keeps a running one with the device's current
  limits applied again (a restart runs the spec it was launched with), and answers the stopped status
  (the kernel reviews a launch only then, race-free). `DeviceServiceStatus` carries `stateDir`, the
  service's state directory, which the command review sees the launch in. `DeviceServiceSpec`
  documents the entry, file and env rules the kernel enforces (no `NODE_*`, `PATH`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, `OPENSSL_CONF`, `OPENSSL_ENGINES`, `LD_*`, `DYLD_*`, `CAPYBARA_*` or proxy
  variables) and that the entry runs from `codeDir ?? stateDir`. `DeviceAccessScope` gains `orgId`;
  `ctx.deviceAccess.addNetworkHosts` takes exact host names only.
  `ctx.deviceAccess.reportBlockedHosts` takes an optional `{ url }`, the page the refused requests
  came from. `ToolCallContext` documents that a call whose device service reported refused hosts runs
  again after an approved network ask, with the same `idempotencyKey`.
- bac42c3: `parseEmbedChildMessage` and `EmbedChildMessage` know the `panel-mode` message (`full: boolean`) an
  embed in the conversation panel sends to maximise or restore the panel.
- 2a552bc: Device services and streams for browser use: `device-provider@1` gains optional `ensureService`,
  `stopService`, `serviceRequest` and `openStream` (`DeviceServiceSpec`, `DeviceServiceStatus`,
  `DeviceStream`); the service socket protocol (`encodeServiceMessage`, `ServiceMessageDecoder`,
  `DEVICE_SERVICE_*`); dial-in stream frames (`stream-open` / `stream-opened` / `stream-data` /
  `stream-credit` / `stream-close`, `DIAL_IN_STREAM_INITIAL_CREDIT`), `DialInChannel.openStream` and
  `DialInStreamElsewhereError`; and `permissions.deviceAccess` with `ctx.deviceAccess`
  (`DeviceAccessCtx`, `DeviceAccessError`).
- b6acad0: `DEVICE_SERVICE_WORKSPACE_ENV` (`CAPYBARA_SERVICE_WORKSPACE`): providers set it for every device
  service to the device's workspace root, and services confine the files they take in and let out
  (uploads, downloads) to it. `DeviceServiceStatus` gains optional `codeDir`, the directory the entry
  runs from when the provider keeps code apart from state (absent: the state directory); the kernel's
  launch review shows `node <codeDir ?? stateDir>/<entry>`, still in the state directory.
- 6034178: `UI_ICONS` adds `globe` for a contribution's icon.

## 0.1.0-rc.69

### Patch Changes

- 18b24bc: Remove the transition compatibility for plugins packed before core#720. The deprecated no-op
  `orgAccess` / `OrgAccess` exports are gone. `defineExtension` now throws on `config.org`, the
  plugin.json reader refuses `extension.manifest.config.org` and `extension.configSchemas.org`, and
  the kernel no longer drops `config.org` from a stored reviewed section. Repack a plugin built before
  core#720 (or install its current release) before upgrading.

## 0.1.0-rc.68

### Patch Changes

- 20e9817: `isPlatformOnly` is true when any node along the wrapper chain carries `platformOnly: true`, like `secret`; an outer `false` never clears an inner `true`.

## 0.1.0-rc.67

### Patch Changes

- af84f8c: A provider whose `update` cannot honor the fence token (E2B) no longer leaves the instance wider than
  the kernel's record until the limits change again (#766). The SDK adds the optional
  `DeviceProvider.appliedNetwork(h, signal)`: the network the instance enforces now, as the provider's
  backend reports it. Under the exclusive lease, on a resumed instance, a running one the use holds
  exclusively, and a new instance of a provider whose limits are fixed at its file system, the kernel
  compares it with the recorded limits; a wider network (the open public network over a list, or a host
  the record does not cover), an unknown one or a failed read applies the desired limits again through
  `update` with the holder's token. Equal or narrower changes nothing.

## 0.1.0-rc.66

### Patch Changes

- 36738ec: A background start's reference names the provider's own instance generation (device-local's bound
  machine generation), so the kernel no longer compares it with its own generation: it matches the
  ref by operation id and handle id and pins the task to the generation it recorded. Every
  background Bash on a device-local device was left unconfirmed ("its start was not confirmed; it is
  being reconciled") and never settled; scheduled recovery now acknowledges those starts. A start
  stopped before it was confirmed now ends `stopped` once the provider acknowledges its operation
  revoke, instead of running until its retention expires (#765).

## 0.1.0-rc.65

### Patch Changes

- b22a19d: A connector template's `description` may be `{ zh, en }` as well as a string
  (`ConnectorTemplateFile.description: string | LocalizedName`); the 1024-character limit applies to
  each text. A plain string stays valid and is shown in both languages. The connector template JSON
  Schema follows.

## 0.1.0-rc.64

### Patch Changes

- 8bdbb9b: Device provider lifecycle calls carry a fence token (device update fencing design, #748). The SDK
  adds `DeviceFence` and `StaleFenceError` (with `isStaleFenceError`): `update` and `create` get the
  device's fencing generation as the calling holder last committed it, `destroy` and `destroyByName`
  get it too (`null` when the kernel holds no device lease). A provider that keeps per-instance state
  stores the highest token next to it and refuses a lower one, so a replica whose lease ended while
  its call was in flight can no longer apply an older network list. The kernel records the target of
  an `update` before sending it (`instance_limits.pending`), so the next exclusive holder applies the
  desired limits again even when the record of what succeeded already matches them; it handles
  `StaleFenceError` as a lost lease and never recreates for it; and a failed record write after an
  `updated` answer no longer falls into the recreate branch (it used to let a stale holder destroy the
  instance a newer holder was using).
- 5d3e31b: Plugin modules packed before core#720 load again on a kernel from main. `orgAccess(schema, access)`
  and the `OrgAccess` type are back as deprecated no-ops (the schema is returned unchanged, both
  levels are ignored: the field stays overridable unless marked `platformOnly`), and
  `defineExtension` drops a `config.org` key instead of refusing it (the manifest keeps only
  `config.deployment`; other unknown `config` keys still throw). `capybara-plugin pack` and the
  checks that import the module still refuse `config.org`. Temporary: removed in core#720 plan
  Task 17 once the official plugins are republished.
- 03fa6f6: Deployment config fields are org-overridable by default: `platformOnly(schema)` marks a field, or the
  whole deployment schema, that only the platform sets (`"x-platform-only": true` in
  `configJsonSchema`, allowed on the root and its top-level properties; `isPlatformOnly` reads it).
  `orgAccess`, `orgAccessOf`, `OrgAccess` and `x-org` are removed, and so is the org-only config:
  `defineExtension({ config })` takes `deployment` only, and the static manifest and
  `extension.configSchemas` have no `org` entry. `web-search@1`, `web-fetch@1` and `directory@1`
  drop `orgConfig`: `config` (the effective config for the org) is required and
  `configured?(config)` takes it alone. Their call args gain `orgId` (the org the call is made for),
  to pass to `configUrlFetch` or `ctx.net.fetch`.
  
  `configUrlFetch(net, { url, platform, orgId })` returns the `fetch` for a config URL an org may
  override: the global `fetch` for the platform's own URL (trailing slashes ignored), `ctx.net.fetch`
  for any other.
  
  `secret`, `platformOnly` and `ui` keep each other's marks whatever their order and whichever
  wrapper (`.optional()`, `.default()`, `.nullable()`, `.prefault()`, `.catch()`, `.readonly()`) they
  sit on, and `isSecret` reads the mark through those wrappers (any node of the chain counts), so
  `platformOnly(ui(secret(x)).optional())` is a secret like `platformOnly(ui(secret(x))).optional()`.
  `configJsonSchema` sets `"x-secret"` (and `"x-platform-only"`) on a wrapper around a marked node
  too, so `secret(x).nullable().default(v)` no longer publishes its default, and the static manifest
  reads the marks the same way.
- 94ed9ef: `defineExtension` refuses any `config` key other than `deployment`; a leftover `config.org` gets
  "config.org was removed: move org fields into config.deployment".
  
  Until the official plugins are republished, `parsePluginManifest` still reads plugin.json files
  packed before this change: a legacy `extension.manifest.config.org` list and
  `extension.configSchemas.org` schema are accepted and dropped (the parsed manifest has no `org`).
  Nothing else reads them.

## 0.1.0-rc.63

### Patch Changes

- 4c1002a: `SANDBOX_RUNTIME_SOURCE.files` is now the Linux launcher with exact file read roots (the
  `current` of core#742; `current` and `files` are the same again), and `accepted` keeps the earlier
  launcher's digest for one revision so device containers made from an earlier device-docker image
  stay available until they are recreated. The image pins device-docker rc.25 (its image stages the
  new launcher and checks staged files against `accepted`) and device-local rc.7, at plugins commit
  03a53c8.

## 0.1.0-rc.62

### Patch Changes

- 95d479c: Linux machine reach reads the files beside a denied path. The SDK's restricted Linux launcher
  accepts exact file read roots (`roots.readFiles`, exec mode only): each an O_PATH, no-follow
  descriptor the consumer pinned, re-checked on that descriptor as a regular file with its recorded
  identity (a link, directory, FIFO or other type is refused; one renamed, deleted or given a second
  name since the pin is skipped), and granted file reads only, without directory
  listing or execution. The device's read carve now grants the non-denied regular files directly
  inside each directory it expands (for example `~/.bashrc` when `~/.ssh` is denied,
  `~/.cargo/config.toml` beside `~/.cargo/credentials`); the agent pins each without following links
  and grants nothing for one that changed type or has a second name. Directories alone above 4096
  refuse machine reach; files fill the rest of the cap and the agent's open-file budget, and the
  rest are dropped. Comparisons with denied paths are case-insensitive for directories too, and
  canonical forms of denied paths are read as bytes. The device deny list adds database, X11 and
  other credential files (`~/.pgpass`, `~/.my.cnf`, `~/.Xauthority`, `~/.ICEauthority`,
  `~/.config/hub`, `~/.boto`, `~/.dockercfg`, `~/.smbcredentials`, `~/.terraformrc`,
  `~/.yarnrc.yml`, `~/.databrickscfg`, `~/.passwd-s3fs`, `~/.erlang.cookie`, `~/.curlrc`,
  `~/.wgetrc`, `~/.claude.json`) and more shell, REPL and editor histories.
  `SANDBOX_RUNTIME_SOURCE` now has three parts so a runtime change no longer has to land in step
  with the images that stage it: `files` (the staged set, unchanged: still the `linux-sandbox.py`
  released images stage, so device-docker keeps working), `current` (the newest bytes, which
  `capybara-device` runs; this launcher declares `features: ["fileReadRoots"]`) and `accepted` (by
  name, every digest a staged copy may have). The device sends file roots only to a launcher that
  declares them; otherwise the files stay unreadable as before. New types `SandboxRuntimeFile` and
  `SandboxRuntimeFeature`.
- 608a3b4: Document the narrowing rule of `DeviceProvider.update`: `"updated"` for a narrowing only once no
  connection to a removed host survives and no new one can open (otherwise `"recreate"` or throw), and
  never a state a later rebuild of the instance could widen.

## 0.1.0-rc.61

### Patch Changes

- e71a6c5: A device report's limit value is text now: `DeviceReportLimit.value` is `DeviceText`
  (`{ en, zh? }`, at most 60 characters per language, checked by `parseDeviceReport`) instead of a
  string, so a provider can translate words in it; a string value no longer passes. Migration 0179
  turns the string values of stored reports into `{ en }`, and the device page shows each value in
  the UI language.

## 0.1.0-rc.60

### Minor Changes

- d68c9fc: Device reports can say how to change a device's limits: `DeviceReport.changeHint` (`{ en, zh? }`,
  in the provider's words). The device page shows it under the limits, and the kernel appends it to
  the refusals that cite the report (an escalated call the device does not allow now, a network the
  device side keeps on the allowlist). A provider's permission support may name who keeps a closed
  crossing closed (`limitedBy: { outsideSandbox?: "owner", openPublic?: "owner" }`): the kernel then
  names the owner of the machine the device runs on instead of the provider.
- ef9ac57: Desktop and native shells no longer manage local devices (maintainer decision 2026-11-23): local
  devices are connected only with `capybara-device`. The SDK drops the shell capability `device@2`
  (`SHELL_CAPABILITY_KEYS.device`, `DeviceCapabilityV2`, `ThisMachineConnection`, `DeviceRunningOp`,
  `DeviceCeilingRequest`, `KeepAwakeMode`, `DeviceConnection`) and the setup-guide directive
  `::shell-action` (`SetupGuideShellAction`, `SetupGuideShellActionLine`, the `shell-action` block,
  `SetupGuidePlaceInfo.shellActions`, `SETUP_GUIDE_LIMITS.shellActions`); a leftover
  `::shell-action` line is now plain text. `GET /api/v1/meta` no longer reports
  `features.localDevices` (`protocols.device` stays). The web drops the 本机 block on the device
  page, the 本机 mark in the device list and picker, and the 连接本机 button in 新建设备.

### Patch Changes

- 21c1852: `DEVICE_DENIED_SECRET_PATHS` denies mise's whole config directory `~/.config/mise` (config files
  with `[env]` sections, the sops age key) and the config files mise loads from the home
  (`~/.config/mise.toml`, `~/.config/mise.local.toml`, `~/.mise.toml`, `~/.mise.local.toml`,
  `~/.mise`, `~/mise.toml`, `~/mise.local.toml`, `~/mise/config.toml`, `~/mise/config.local.toml`,
  `~/mise/conf.d`, the legacy `~/.rtx.toml` and `~/.rtx.local.toml`; globbed names such as
  `~/mise.<env>.toml` cannot be listed and stay readable), and the Maven and Gradle credential files
  (`~/.m2/settings.xml`, `~/.m2/settings-security.xml`, `~/.m2/settings-security4.xml`,
  `~/.gradle/gradle.properties`, `~/.gradle/develocity/keys.properties`,
  `~/.gradle/enterprise/keys.properties`). Sandboxed work on a local device never reads them, and the
  kernel never proposes an approval for them. A sandboxed Maven or Gradle build no longer gets those
  settings: on Linux it sees the files exist but cannot open them and may fail (Maven: "Non-readable
  settings"); on macOS they look absent. Gradle init scripts and a moved `GRADLE_USER_HOME` are not
  covered. On Linux under `machine` reach, files directly in `~/mise`, `~/.m2` and `~/.gradle` become
  unreadable too.
- 0eb3412: `SetupGuidePlaceInfo` gains `checks`, whether guides of a place may use `::check` lines. It is
  false for `device-connection` (a device guide has no target to check): `validateSetupGuide`, and so
  `capybara-plugin check` / `pack` and the kernel's import, now refuse a check line there instead of
  the web drawing nothing.
- d649c6b: `DeviceReport` and `ctx.devices.reportChanged` docs: the revision must change whenever what was
  approved against the report changes; display-only facts may change under the same revision and are
  announced with `reportChanged`, which stores the new text without invalidating approvals.

## 0.1.0-rc.59

### Minor Changes

- 6aa42a6: Setup guides: a `connector-template` guide names one or more templates (`templates: string[]`,
  replacing `template`; a template still has at most one guide), so one guide can serve several
  templates of a plugin. `{{templateId}}` / `{{templateName}}` render the template the guide is shown
  for: the target connector's, the new `templateId` query parameter of the guide routes, or the
  guide's only template (else unresolved with reason `no_template`). The `extension-deployment`
  place now offers `{{signInCallbackUrl}}` (`<publicUrl>/api/v1/auth/sso/<plugin>/callback`), built
  from the same path constant as the SSO flow's redirect URI. `capybara-plugin pack` / `check` refuse a guide naming
  a scanned template the plugin lacks.
- f99d11c: `ToolCallContext.idempotencyKey`: the key of one logical tool call (64 lowercase hex, derived from
  the conversation, the run and the call id), the same across every `InputRequired` round of the
  call. A tool with an external side effect passes it downstream (for example as an
  `Idempotency-Key` header). The SDK docs now state that a call id is unique only within its run and
  that the kernel never retries a call whose result is unknown.

### Patch Changes

- a284fac: A device provider that finds its instance gone before a managed operation reached the machine
  throws `DeviceRequestNotSentError` with the `SandboxGoneError` as its `cause`: the operation is
  recorded as not started (the model is told nothing ran and may retry) instead of an unknown
  outcome, and the kernel rebuilds the instance at once so the retry runs on it.

## 0.1.0-rc.58

### Minor Changes

- 620f3db: `DeviceLocalPolicySummary` (the device hello's and `policy` event's `policy`) gains the optional
  `sharedProjectRoots`: the connection's project directories another connection on the same machine
  also uses, only those the owner listed for that connection, at most `MAX_DEVICE_SHARED_PROJECT_ROOTS` (256) absolute paths. A malformed value is
  dropped by the parser and the rest of the summary is kept; the device protocol stays 6.

## 0.1.0-rc.57

### Minor Changes

- 5d2b9f3: device protocol 6: per-connection project reach and project refusals
  
  `DEVICE_DENIED_SECRET_PATHS` also lists more tool credential stores (cargo, 1Password CLI, Vault,
  Terraform, Claude Code, Codex, keyrings, pass, rclone, s3cmd, mise's `config.toml`) and the bash
  and zsh histories, since sandboxed work on a local device now reads the whole machine by default.
- 271d6d9: The desktop shell capability `device@2` replaces `device@1`: a machine may hold several
  connections into a deployment. `DeviceCapabilityV2.status()` returns
  `{ connections: ThisMachineConnection[] }`; `running`, `pause`, `resume`, `disconnect`,
  `requestCeiling` and `setKeepAwake` name the connection by `deviceId`; `connect({ orgId })` adds a
  connection and may answer `{ error }`; `onStatus` passes nothing (read `status()` again).
  `RunningOperationView` is renamed `DeviceRunningOp`; `ThisMachineStatus` and `DeviceCapabilityV1`
  are removed. `DeviceCeilingRequest.projectReach` takes `machine | paths | workspace`. The web marks
  every device of this machine 本机 (device list, new-conversation picker) and acts on the device of
  the page; 连接本机 is offered whenever the shell offers `device@2`.

## 0.1.0-rc.56

### Minor Changes

- 9318195: `ctx.dialIn.capacity(deviceId)`: the negotiated `maxFrameBytes` of the machine's current
  connection (the value the kernel sent in `ready`: the smaller of the machine's announced cap and
  `devices.dialIn.maxFrameBytes`), or null when no machine holds the device. Read from the holder's
  Redis record under its lease, so any replica answers; only for the calling provider's own devices.
- d5d295f: `DialInHandler` callbacks name the machine and the connection: `onHello`, `onFrame` and `onClose`
  get a last argument `DialInConnectionInfo` (`{ machineId, connectionId }`): the authenticated
  machine's id and the connection id the kernel sends in `ready`. A `replaced` close carries the old
  machine's id, so a provider can tell a replaced machine from its successor.

## 0.1.0-rc.55

### Patch Changes

- a938c37: The composer exposes its pieces as UI parts: `composer.box` (the text with ＋ and send; the
  floating pill in the mobile form, `:focus-within` while one of them has focus, never for the control
  row), `composer.options` (the mobile settings chip) and `composer.send` (send, and stop in its
  place). The pill is now that real element instead of the frame's `::before`, so a theme's frame,
  corners and run effects can follow it without enclosing the chip row; the control row sits outside
  it (the DOM order is the text, ＋, send, then the row). In the mobile form send keeps its place at
  the pill's end when the agent picker above it is wider. `Button` and `IconButton` let a caller's
  `data-cap-part` name the control too.

## 0.1.0-rc.54

### Minor Changes

- f761d8f: `bootstrap.json` entries that are optional preinstalls (neither `required` nor `builtin`) accept
  `scope: "all"`: the catalog item is created on in every org and an org admin may switch it off.
  The scope is read only at the first import.
- d1d0861: `capybara-device` speaks protocol 5 over the dial-in envelope: it sends
  `X-Capybara-Device-Protocol: capybara-device/5` (`DEVICE_DIAL_IN_PROTOCOL`), names that protocol
  when it signs in, and wraps every frame in the envelope (`hello` with the program facts and the
  frame capacity, `req` / `res` / `event` with a device protocol body, the kernel's `ready`,
  `cancel` and `stop`). The kernel's `ready` names the connection's effective frame capacity
  (`maxFrameBytes`, at most what the machine announced); the program sends no larger frame on that
  connection. A kernel `stop` with reason `drain` drains the program and exits it; reason `stop`
  stops the owned work at once and exits with the reason the kernel's close names. The hello body (`DeviceHello`) no longer carries the program facts, the
  recent policy ops or the `policyOp` / `policyOpId` features. The deployment can no longer change
  a machine's policy: the `policy` and `policyStatus` operations, `DevicePolicyArgs`,
  `DevicePolicyResult` and `DevicePolicyStatus` are removed, and the device keeps no policy op log;
  a change the owner makes on the machine is still pushed as an event. `parseDeviceFrame(body, kind)`
  parses one body; `parseDialInKernelFrame` parses a kernel frame on the machine. A 426 names the
  protocol the deployment serves the device with, and the program says which side to update.
- c69c0f0: The device protocol frames (`parseDeviceFrame`, `DeviceFrame`, `DeviceHello`, ...) move from the
  package root to the subpath `@capybara-hq/plugin-sdk/device-protocol`. The `list` / `scan` bounds
  of the `device-provider@1` contract stay at the root: `MAX_DEVICE_LIST_ENTRIES` now lives with the
  scan bounds in the device-provider module (one definition, which the protocol subpath imports), so
  providers built against the previous SDK still load.
- 6265634: Dial-in channel contract: `permissions.dialIn = { protocol }` for a `device-provider@1` extension,
  `DialInHandler` (`DeviceProvider.dialIn`), `ctx.dialIn` (`DialInChannel`), `ctx.devices`
  (`DevicesCtx`), the frame envelope (`DialInMachineFrame`, `DialInKernelFrame`,
  `parseDialInMachineFrame`, `DIAL_IN_PROTOCOL_RE`), `DeviceOfflineError`, and
  `DeviceRequestNotSentError` moved from the kernel into the SDK.
- 5bef1fd: Local device semantics leave the kernel: the kernel-internal `@local` provider, its machine
  reports, owner reports, instance bindings and boot history are gone; the kernel knows only
  generic dial-in devices (a provider implementing `DeviceProvider.dialIn` and declaring
  `permissions.dialIn`), and the `device-local` plugin takes local devices over. Until it is
  installed, a deployment has no local device provider. Local devices registered before the upgrade stay
  bound to the removed `@local` provider and are unavailable (`device.unavailable`; their files stay
  on the machine); their owners delete them on the devices page and connect the machine again with a
  `capybara-device` that signs in to the `device-local` provider. Migration 0177 drops `device_machines`'
  `features`, `local_policy`, `owner_report`, `pending_policy_ops`, `home`, `roots`, `mode` and
  `session_isolation`, the tables `device_machine_boots` and `device_instance_bindings`, and
  `devices.source`; a machine credential is accepted for any device a machine signed in to, and the
  connection's provider check decides the rest. The error codes `device.policy_refused`,
  `device.policy_unsupported` and `device.owner_report_stale` are removed. The dial-in config moves from
  `devices.local.*` to `devices.dialIn.*` (`CAPYBARA_DEVICES__LOCAL__*` becomes
  `CAPYBARA_DEVICES__DIAL_IN__*`); rename any value you set.
  
  The SDK's `device-protocol` subpath drops the protocol 4 surface: `LEGACY_DEVICE_PROTOCOL_VERSION`,
  `LegacyDeviceHello`, `LegacyDeviceFrame`, `parseLegacyDeviceFrame`, `KernelReq`, `KernelCancel`,
  `DeviceRes`, the policy op types and constants (`LegacyDevicePolicyArgs`,
  `LegacyDevicePolicyResult`, `LegacyDevicePolicyStatus`, `DevicePolicyStatusArgs`,
  `DevicePolicyOpReport`, `DevicePolicyOpOutcome`, `isPolicyOpId`, `POLICY_ADD_REFUSED`,
  `MAX_POLICY_OP_ID_LENGTH`, `MAX_RECENT_POLICY_OPS`) and the `policyOp` / `policyOpId` features;
  `DeviceOp` no longer lists `policy` / `policyStatus`.

### Patch Changes

- ee9ae2a: Move the logo SVG viewBox parser into an internal module so its non-backtracking structure is
  tested directly; no behavior change.

## 0.1.0-rc.53

### Patch Changes

- c6935ea: `nav@1` (shell capabilities) gains the Duo strip's pill action, account and side: `set` takes a
  required `action` and an optional `account`, the handle has `onAction`, `onAccount` and `side`, the
  items may include `search`, and `menu` / `NavMenuV1` / `onMenu` are removed (the strip has no menu
  button any more). The mobile app's nav@1 must ship together with this web: an older shell rejects
  the new state.

## 0.1.0-rc.52

### Minor Changes

- 1834986: An `oauth_code` auth preset may set `authorizationParams`, extra query parameters of the
  authorize request (Google's `access_type: "offline"` and `prompt: "consent"`, Slack's `team`):
  at most 10, lowercase names, plain printable values, never a secret. The kernel appends them after
  its own parameters on every connect and reconnect, never on a token request. Names the kernel owns
  or that would change the callback or the token exchange (`OAUTH_RESERVED_AUTHORIZATION_PARAMS`)
  are refused there and in the query of a manual `authorizationUrl`. A template update that changes
  only `authorizationParams` keeps members' connections. A member whose access token dies without a
  refresh token is now asked to reconnect instead of told the authorization server is unavailable.
  `startFakeOAuthServer` records the form parameter names of each token request (`paramNames`).

## 0.1.0-rc.51

### Minor Changes

- 718eb52: Add the setup guide place `device-connection` (member audience; variables `publicUrl`, `orgId`,
  `orgName`, `pluginName`) and the `::shell-action connect-this-machine <label>` directive, so device
  provider plugins can ship connection guides. Rendered guides carry a `shell-action` block; at most 4
  per document, allowed only in this place. The kernel serves these guides to org members
  (`agents.use`). `capybara-plugin guide` prints shell actions.
- f4c2ae8: Rename the `sandbox@2` extension point to `device-provider@1`, a multi-provider point: several
  device providers can be loaded side by side. `SANDBOX_EXTENSION_POINT` becomes
  `DEVICE_PROVIDER_EXTENSION_POINT` and `SandboxProvider` becomes `DeviceProvider`. The
  `sandbox-docker` bootstrap pin is removed.
- 42e4ae0: `device-provider@1` providers now declare `networkAllowlist: true` and implement
  `report(device, signal)`, which answers a `DeviceReport` (revision, description, home, limits,
  reset; checked by `parseDeviceReport`). A provider can refuse a project directory with
  `ProjectPathRefusedError`. The kernel refuses to load a provider that lacks any required member.
  The kernel stores each device's report (`devices.report`, migration 0175), refreshed after its
  instance is created or resumed; request paths read the stored copy.
- 78fe943: An operation scope's filesystem is now `{ kind: "scoped", projectRoot, writeRoots }`: the scope
  names the project root (null in free mode) and the roots the operation may write, and no longer
  carries read roots; what a sandboxed operation may read is the device provider's rule. The scope
  parser refuses a `readRoots` key. Device protocol goes to 5 (`DEVICE_PROTOCOL_VERSION`), and a
  protocol 4 program is refused with 426 ("Update capybara-device"). `capybara-device` derives its
  read roots from the write roots, the project root (the workspace in free mode) and its skills root;
  an approved read outside the project is not conveyed to a local device for now. The permission
  conformance suite sends the fixture root as the project root.

## 0.1.0-rc.50

### Minor Changes

- ada3723: Theme files gain brand fields (`logo.illustration`, `logo.appIcon`, `logo.appIconMaskable`, `decoration`, `avatars`, `hideAvatarPresets`) with their checks, plus `BUILTIN_AVATAR_PRESET_IDS` and `themeAssetRefs`.

### Patch Changes

- bfb0fc0: An identity source can refuse an account on purpose: the SDK adds `IdentitySourceRefused` and
  `isIdentitySourceRefused`, and a login refused that way returns to the sign-in page with
  `sso.account_not_allowed` ("This account is not allowed to sign in on this platform…") instead of a
  generic provider error. The plugin's message is only logged.

## 0.1.0-rc.49

### Minor Changes

- 05eba7f: The device protocol gains the error kind `unsettled`: a device reports earlier work that has not
  settled (a new instance or a supervisor close refused) as `SandboxWorkUnsettledError`, a subclass of
  `SandboxPermissionUnsupportedError`, so every existing definite-refusal check still applies.
  `isSandboxPermissionUnsupportedError` now matches any subclass by its inherited tag. Upgrade the
  kernel before devices: a kernel that predates this kind answers a protocol error to that request.

## 0.1.0-rc.48

### Minor Changes

- 09a0bc5: Add the extra bootstrap manifest format (`BootstrapExtraManifestSchema`, `parseBootstrapExtraManifest`)
  and the git marketplace username helpers (`suggestGitUsername`, `GIT_MARKETPLACE_USERNAME_DEFAULT`,
  `GIT_USERNAME_RE`). A git entry's `path` may be `.` / `./`, the repository root of a single-plugin
  repository.

## 0.1.0-rc.47

### Minor Changes

- 0756b7b: `MOBILE_SHELL_LIMITS` gains `navLabel` (32) and `navCount` (9999), the bounds a shell validates
  `nav@1` state against (section and menu labels, badge counts).

## 0.1.0-rc.46

### Minor Changes

- a007fee: Add the `push-provider@1` extension point (`PushProvider`, `PushError`, `PUSH_LIMITS`,
  `checkPushResults`, `validatePushMessage`; a message carries a `collapseId` per event) and the
  `push@1` shell capability types.
- 12a6582: Add the setup guide place `extension-deployment`: a plugin's guide on the super admin's extension
  page whose checks get the extension's platform deployment config (`SetupCheckTarget` kind
  `extension-deployment`; `SetupCheckArgs.orgId` is now `string | null`, null for this place). The
  `fake-push` fixture ships such a guide with the check `fake-push-key`. The kernel serves these guides
  and runs their checks on super admin routes (`/api/v1/admin/extensions/:name/guides…`) and the
  `extensions.platform-guides`, `extensions.platform-check-status` and `extensions.platform-check`
  Platform operations; the web shows them with live check rows on the extension's config tab.

## 0.1.0-rc.45

### Minor Changes

- dfea642: Add the `nav@1` shell capability (the native strip's sections, current section and menu button:
  `NavCapabilityV1`, `NavStateV1`, `NAV_SECTION_ORDER`) and `profiles@1` (`ProfilesCapabilityV1`,
  the native profile switcher).
- 614d852: Touch tokens and the code font role. One `@media` block in the generated tokens carries the touch
  overrides (system font, larger type, 44 px controls and rows, rounder corners) for a coarse
  pointer; `--cb-font-code` keeps Sarasa on code, commands, paths, versions and times. New tokens:
  `float-ground`, `float-line`, `shadow-float-touch`, `radius-pill`, `layout-drawer` and the
  `touch-*` sizes. The new colors and the shadow join the SDK's overridable theme tokens.

## 0.1.0-rc.44

### Minor Changes

- e21de78: Shell capability types for the mobile app: `haptics@1`, `share@1`, `menu@1`, `chrome@1`
  (with an optional `ready`), the `MOBILE_SHELL_LIMITS` and `MENU_ITEM_ID`.

### Patch Changes

- 072362d: Desktop onboarding: `GET /api/v1/meta` lists `appRedirectUris` (`auth.appRedirectUris` while app
  sign-in is available, else empty), so the desktop app can say before opening the browser that the
  platform does not allow it; the app token exchange answers `auth.account_disabled` (403) for an
  account that is not active instead of `app_auth.code_invalid`. `chrome@1.setAppearance` also
  carries the page's seven main color tokens (only when all are plain colors) and `singleScheme`
  under a single-scheme UI theme; the SDK gains `ChromeCapabilityV1`, `ShellChromeTokens` and
  `SHELL_CAPABILITY_KEYS.chrome`.
- 8f684ad: A local device's hello names its program run (`programRunId`, random per process). When the machine
  reconnects as a new run before answering a request, the kernel ends that request's wait at once with
  a tool error saying capybara-device restarted and the result is lost, instead of waiting out the
  command's whole timeout plus the reconnect grace.

## 0.1.0-rc.43

### Patch Changes

- 2c2841e: The Platform tool creates connectors, sets their credentials, installs catalog items with their
  connector and config secrets, and creates channels, with every secret typed by the person on the
  confirmation card. Org admins' agents invite, revoke and manage members (never self, never an owner,
  never above the actor); an invitation link is sealed for the approver and revealed once on the web.
  Platform results can pop up a handoff card (a link to a web page, or a Connect button for OAuth).
- ff64a43: A native read whose read root is a single file works: the device pins the file's parent directory
  and the native helper reaches only that one name through it (macOS and Linux). A kernel read of a
  project narrows `AGENTS.md` to itself, and the device refused it with `ENOTDIR`, so a project's
  `AGENTS.md` never reached a run.

## 0.1.0-rc.42

### Patch Changes

- e788a1a: Person fields: a Platform write that needs a secret takes its field name in `askPerson`, and the
  person types the value on the approval card on the web; it is sealed, read once by the resumed call
  and never reaches the conversation, the audit or a log. Agents can now read and set extension
  deployment config, org config and the org's config copy through the Platform tool.

## 0.1.0-rc.41

### Minor Changes

- cfa657f: `DeviceCapabilityV1.requestCeiling` takes the device's owner ceiling fields as a partial
  (`DeviceCeilingRequest`: `outsideSandbox?`, `network?`, `projectReach?`, the names of
  `capybara-device ceiling set` and `ceiling show --json`); a field left out is never touched. The
  device page widens through it again on this machine, one field per action, when the desktop shell
  offers the call.

## 0.1.0-rc.40

### Patch Changes

- e8b4d00: The built-in theme tokens gain `preview-light` and `preview-dark`, the two fixed grounds of the
  app-icon preview (the same in both themes). They are not in `THEME_OVERRIDABLE`: a theme cannot
  change them.
- d9602dc: Declare `"sideEffects": false`: the package has no import-time side effects, so a bundler that imports
  one export no longer pulls in the whole SDK.

## 0.1.0-rc.39

### Patch Changes

- 23bee16: The device protocol carries a scope validation failure as its own typed kind (`invalid`): the
  device answers a scope the contract refuses (such as the environment network without the device
  filesystem) with it, and the kernel raises it as a `SandboxScopeValidationError` instead of an
  untyped machine error.
- 9429b63: Linux open network (approval-only profiles).
  
  - Device: a sandboxed Linux command with the open network reaches any public name or address
    literal on any port through its operation's proxy. The proxy dials only resolved addresses the
    SDK's address-class table calls public (its Python copy is kept equal by a test), that Python
    also calls global, and that are not this host's own (nor, on a local-Docker device, the host's
    interface addresses, passed into the container). Private and LAN ranges, CGNAT, ULA,
    link-local and metadata addresses (Azure's `168.63.129.16` too), loopback, NAT64 and the
    reserved ranges stay closed, by name, literal or IPv4-mapped form; a refusal is a 403 before any
    connect, for the allowlist too. The proxy serves at most 128 connections at once. The Linux and
    local-Docker backends report `openPublic: true`. An escalated call starts from the owner's
    environment without `CAPYBARA_*` variables (`hostCommandEnv` replaces `hostBaseEnv`).
  - Protected home locations: at operation start the worker resolves each protected location under
    the home component by component (`protected-targets.ts`, shared by the platform workers),
    following dangling links, and denies every link on the chain and the final target, anchored.
  - Fake-IP resolvers: when the system resolver answers a name with an address in `198.18.0.0/15`
    (a router running a fake-IP proxy such as OpenClash), the forwarder re-resolves it through
    DNS-over-HTTPS and checks and dials the real address; if encrypted DNS fails the request is
    refused with a 403 naming the fake-IP resolver, and the fake address is never dialled. SDK:
    `SANDBOX_FAKE_IP_DNS` (RFC 8484 at `1.1.1.1`, `1.0.0.1`, `8.8.8.8`, `8.8.4.4`; one 5 s
    deadline per name; cache TTL cap 300 s, at most 256 names, complete answers only).
  - SDK (`linux-sandbox.py`): no sandboxed connect reaches a loopback listener, the command's own
    included (clients outside the sandbox reach it). `SO_REUSEPORT` and `SO_ATTACH_REUSEPORT_*`
    are refused by seccomp, and the broker never binds or listens a socket with `SO_REUSEPORT` set.
    A `symlink` named for a proper prefix of a multi-component write deny is refused. A directory
    move into a guarded prefix first renames the directory to a reserved staging name beside it,
    which no sandboxed process may write, lists and checks it there and renames it into place with
    NOREPLACE; a refused or failed step moves it back, and when that fails too it goes to a
    quarantine name and the operation ends, reported. The move holds an exclusive lock against the
    operation's other writes, waiting at most 5 s (then EBUSY). New request field `writeDenies`
    (absolute paths denied like the system spools).
  - SDK write policy: an ancestor of an anchored deny (a system spool, or a consumer's resolved
    target) never moves away, and `SANDBOX_RESERVED_NAME_PREFIX` (`.capybara-staging-`, the broker's
    staging and quarantine names) is denied to every sandboxed write, folded.
- 75d8984: macOS restricted operations now enforce the sandbox network on the resolved address: the
  operation's own proxy decides every connection and dials the address it checked. Private and LAN,
  CGNAT, ULA, link-local, cloud metadata (Azure `168.63.129.16` included), NAT64, loopback (another
  process's localhost port, `localhost` itself) and this host's own addresses stay closed in the open
  network and in the allowlist alike, for names and IP literals (an allow-listed literal gets no
  carve-out; the patched sandbox runtime's `resolvedAddressStrict`). The device reports
  `openPublic: true` on macOS; a runtime without the network patch is refused. Behind a fake-IP
  resolver (a router answering every name with `198.18.0.0/15`), the proxy re-resolves the name
  through DNS-over-HTTPS (RFC 8484) at the SDK's new `SANDBOX_FAKE_IP_DNS` endpoints, judges the real
  answer, and refuses when that lookup fails. Listening stays refused on macOS. The write rules gain
  the system persistence paths (`SANDBOX_SYSTEM_WRITE_DENIES`, now exported by the SDK) and, at
  operation start, every symbolic link on the way to a protected home location plus its final target
  (a dotfile manager's `~/.zshrc` chain), with no move of their ancestors. Only the escalated pair
  runs unwrapped, and an escalated call's environment drops every `CAPYBARA_` variable.
- 0c0f51f: Device protocol 4 (approval-only profiles), a paired kernel and device release with no fallback.
  
  - SDK (breaking): `SandboxPermissionSupport` is version 2 (`boundary`, `network`, `outsideSandbox`
    instead of `fullAccess`), `DeviceOwnerCeiling` is version 3 (`outsideSandbox`, `network`,
    `allowedDomains`), `DeviceOwnerCeilingNarrowing` narrows each of them, and the strict parsers are
    `parseSandboxPermissionSupport`, `parseOwnerCeilingReport` and `parseOwnerCeilingNarrowing` (the
    interim `…V2` / `…V3` names are gone). `SandboxLimits.mode` is removed: lifecycle create and update
    carry resources and the outer network only, and `list` / `scan` take no `limits`. The policy
    summary has no `mode`, the `mode` feature is gone, and a `policy` op that adds hosts or carries a
    `mode` is refused (`POLICY_ADD_REFUSED`: widening happens only on the machine).
    `DEVICE_PROTOCOL_VERSION` is 4 and `LEGACY_DEVICE_PROTOCOL_VERSION` 3.
  - Device: the hello, `policy` frames and answers carry the version 3 owner report and the version 2
    support report; the `policy` op refuses `add` and `mode` and writes nothing; `status` shows the
    sandbox network and the outside-sandbox setting; the login token field is `outsideSandbox`. A
    protocol 4 program facing an older deployment says the deployment must be upgraded.
  - Kernel: refuses protocol 3 programs with 426 and an update instruction; reads the new owner and
    support reports (a machine without a protocol 4 report fails closed); never sends `add` to a
    local device: the device page's add is refused with the machine command, and an approval's
    "always allow" for a host becomes a grant for the run. The facts field `fullAccessCeiling` is
    `outsideSandboxCeiling`.
  - Testing: the conformance suite reads `outsideSandbox` and accepts the scope contract's refusal of
    a restricted environment-network operation.
- d6be3f7: The SDK contract of approval-only permission profiles. The scope parser, the address classes and
  the write policy below are live now; the new parsers wait for the protocol 4 cutover.
  
  - `parseSandboxOperationScope` accepts the `open-public` network. The `device` filesystem and the
    `environment` network are accepted only together (the escalated call).
  - `classifyAddress`, the data table `ADDRESS_CLASS_RANGES` (`AddressClassRange`) and
    `OPEN_PUBLIC_DENIED_CIDRS`, the closed set as CIDRs: longest prefix first; v4-mapped, SIIT,
    v4-compatible and 6to4 forms classify as their IPv4 address; Azure WireServer `168.63.129.16`
    is metadata; the well-known NAT64 prefixes, `2001::/23`, `3fff::/20` and IPv6 space outside
    `2000::/3` are closed. Operator-specific NAT64 prefixes are not covered.
  - Strict parsers `parseSandboxPermissionSupportV2`, `parseOwnerCeilingReportV3` and
    `parseOwnerCeilingNarrowingV3` (a narrowing can only narrow).
  - The restricted write policy denies the OS persistence locations: `Library/LaunchAgents` and
    `LaunchDaemons`, `.config/systemd`, `.local/share/systemd`, `.config/environment.d`,
    `.config/autostart`, KDE `autostart-scripts` and `plasma-workspace/env`, `.xprofile`,
    `.xsessionrc`, the remaining shell startup and logout files, `.config/git/config`, fish's
    `config.fish` and `conf.d`, and the absolute spools `SANDBOX_SYSTEM_WRITE_DENIES`. Protected move
    names come only from single-component entries; a multi-component entry refuses a move whose
    destination ends in its prefix when the moved directory holds the next component
    (`isSandboxMoveDenied` takes the directory's entries). New runtime digests: `linux-sandbox.py`
    c77731022868b92b67be3643b54c6260fcfbdc65e283cd9b8f7be03f4b6b0b9e, `native-files.py`
    029f47a8663ce7a40674657f856d07cc58cb5b9374c85d3edf69f3979b380a48.
  
  Kernel: the public-address checks refuse the Azure WireServer (`168.63.129.16`) whatever the
  exemptions, like the other cloud metadata endpoints.
- c3752c0: Device protocol: `exec` and `create` `limits` (and their `network`) refuse unknown keys. Protocol 4
  removed the `mode` tier, so a stale `limits.mode` is now a protocol error instead of being ignored.
- 3ec77c8: Upgrade notes for approval-only profiles (device protocol 4).
  
  - Full access consent resets once on upgrade. A stored owner report from a protocol 3 device
    (owner report version 2) is unparseable for the new kernel, so its machine fails closed until the
    upgraded device program reports again, and every conversation on Full access falls back to
    Approve for me. People choose Full access again once their device is upgraded.
  - Sandbox providers must report `permissionSupport` version 2 (`boundary`, `restricted`,
    `network { openPublic, allowlist, perOperationHosts }`, `outsideSandbox`, `background`); a
    provider without it is unprobed and admits no operation. Providers must not require or read
    `limits.mode`: lifecycle `create` and `update` carry resources and the outer network only, and a
    device's `exec` / `create` limits refuse any other key.
- 1878227: The protocol 4 shapes of approval-only permission profiles, next to the protocol 3 ones until the
  cutover: `SandboxBoundary`, `SandboxPermissionSupportV2`, `DeviceNetworkMode`,
  `DeviceOwnerCeilingV3` and `DeviceOwnerCeilingNarrowingV3`, the `open-public` operation network
  scope, and the address-class table (`AddressClass`, `OPEN_PUBLIC_DENIED_CLASSES`,
  `classifyAddress`).
- f5b114c: An instance-boundary runtime report that names an `unavailableReason` (a stale image, a digest
  mismatch) now reads as unsupported. The SDK adds `instanceSupported(report)`: true only for
  `boundary: "instance"` with no reason. The kernel uses it for recorded runtime availability, the
  withheld scope, the kernel-read route and the held-operation check, so a network-`none` native
  call or execution on such a device is refused instead of running.
- ca6929a: Linux restricted execution: a directory move into a guarded place (`.claude`, `.config`, …) can no
  longer slip between another operation's write check and its effect.
  
  - Every restricted operation of a device now shares one files lock: an `flock` on a private file
    outside every sandbox (the device's state directory on a host, the container's `/dev/shm` for a
    local-Docker device). Each brokered write holds it shared from its check to its effect; a guarded
    directory move holds it exclusively (still EBUSY after 5 s). The launcher takes the lock as an
    inherited descriptor (`filesLockFd`, optional for other consumers) and refuses one inside a
    granted root; the restricted command never holds it.
  - After each descriptor-relative create or rename (mkdir, mknod, open with O_CREAT, symlink, link,
    rename, the staged move's final rename) the broker checks where the parent sits now; an entry
    that landed at a denied path is undone and refused, and an undo that fails ends the operation.
    Truncation (O_TRUNC, truncate) waits for that check.
  - Restricted native writes (Write, Edit) the device's Linux agent makes itself take the same lock
    shared from their check to their effect, and the native helper checks every directory and file
    it creates again at its parent's current place (Linux), undoing and refusing one that landed at a
    protected path.
- 7f7db5f: The sandbox never writes the PATH-shim directories a later shell runs programs from:
  `~/.local/bin` and `~/.cargo/bin` join `SANDBOX_MANDATORY_WRITE_DENIES`, and the new
  `SANDBOX_HOME_WRITE_DENIES` (`~/bin`, anchored at the owner's home, checked with
  `isSandboxHomeWriteDenied`) is denied by the device workers and never proposed by the kernel.
  `cargo install` and similar installs into those directories need a per-call escalation.
- 7f7db5f: A sandboxed command no longer reaches another process's UNIX socket inside its write roots. The
  Linux broker connects a pathname UNIX socket only when the operation bound it itself (its dev and
  inode recorded at the brokered bind), so a user D-Bus, a rootless `docker.sock`, ssh-agent or tmux
  in a granted directory, or `~/.docker/run/docker.sock` under a project bound at the home, stays
  unreachable. As defence in depth the kernel's candidate builder and admission and the device's root
  check refuse a write root that is a system runtime or socket directory (`/run`, `/var/run`,
  `/private/var/run`, `/dev`, `/proc`, `/sys`, `/tmp` and `/private/tmp` themselves, known socket
  directories such as `/tmp/tmux-<uid>`): new SDK `sandboxRuntimeDirectoryOf` and
  `SANDBOX_RUNTIME_DIRECTORIES`. The permission conformance gains the `foreign-unix` check.

## 0.1.0-rc.38

### Minor Changes

- d4fbc1f: Add the desktop shell capability types: `DeviceCapabilityV1`, `NotifyCapabilityV1`,
  `OpenExternalCapabilityV1`, `SignInCapabilityV1`, `ThisMachineStatus`, `ShellCallError` and the
  `SHELL_CAPABILITY_KEYS` constants.
- 091cd08: Add the Shell environment types (`CapybaraShell`, `SHELL_CAPABILITIES`) and the compact form of UI
  slots: `UiSlotSpec.compact`, `UiContribution.compact` (a contribution may only narrow its slot's
  form), `CompactForm` and `effectiveCompact`.

## 0.1.0-rc.37

### Patch Changes

- 10ecf48: `parseDeviceFrame` checks a `writeFile` payload's base64 in one linear pass: the previous pattern
  overflowed the regex stack on Node 24 for payloads above about 3.3 MB, so larger device writes failed.
- 311c56e: `ModelCallPurpose` gains `"vision"`: the call that reads an image for a model without vision.

## 0.1.0-rc.36

### Minor Changes

- dcfc62e: The device protocol's scope-bearing operations move into `device-protocol.ts` under their
  canonical names (`DeviceHello`, `parseDeviceFrame`, `parseOperationResult`, `DeviceOwnerCeiling`,
  `KernelRequest`, `DeviceResponse`, `BindInstanceRequest`, ...; the `V3` suffixes and
  `device-protocol-v3` are gone). Protocol 2's frames that a protocol 3 name replaced keep a `Legacy`
  prefix (`LegacyDeviceHello`, `parseLegacyDeviceFrame`, `LegacyDevicePolicyArgs`, ...).
- 3cb0cf5: `BACKGROUND_LAUNCH_LINE` and `isBackgroundLaunch` are removed. They marked the old session-id
  background launcher's command, which no kernel sends any more: a background task starts through
  the device's `backgroundStart` operation.

### Patch Changes

- 1c6ca44: `SandboxBackground.start` takes an optional `instanceGeneration`: the kernel passes its generation
  of the held instance to a cloud provider, which cannot know it otherwise (it is allocated after
  `create` returns) yet must name it in the reference the kernel acknowledges. Without it no cloud
  background start could ever be acknowledged. A bound local device is not told; it knows its own.
- 1d3eb12: `DEVICE_DENIED_SECRET_PATHS` and `DEVICE_DEFAULT_STATE_PATH`: the paths a local device never
  opens to restricted work, one source for the device and the kernel.

## 0.1.0-rc.35

### Patch Changes

- eea8ef6: Model-facing text states mechanisms, contracts and limits only. Bash keeps the proxy rule general
  (no browser flag) and says "keep results in files" once; Deliver states the one-file contract and
  that an HTML file is shown on its own (no tar or CDN recipe); the skill registration errors state
  the zip package format instead of a `zip -r` recipe; Read / Glob / Grep drop the write-approval
  sentence; the ToolSearch catalog header, WebSearch (cite once, in the description), the WebFetch
  extraction prompt, Agent / SendMessage results and the Platform tool and operations lose
  duplicated or one-slip warnings ("never guess", "there is no all", "agents never decide" in every
  hint, "never remembered", old field-name hints). Platform text names pages by their English
  labels. Agent docs: `concepts.md` describes devices instead of "a sandbox per conversation", and
  the docker socket rule leaves the model-facing sandbox doc (it stays in the contributor skills).
  The new-agent AGENTS.md starter no longer repeats the platform's behaviour rules.
- 9f8c8d5: `ModelCallPurpose` (and `UsagePurpose`) gain `suggestion`: the prompt suggestion side request after a completed run.

## 0.1.0-rc.34

### Minor Changes

- 40d039f: `channel@1` gains the optional `sendFile` and `features.files` (one conversation artifact per message, `ChannelSendFileArgs`, `ChannelFile`); `asCode` is exported.

### Patch Changes

- 45ff51f: New UI part `image-placeholder` (`aria-busy`): the placeholder the conversation draws while an
  image is being generated. The design package adds `ImagePlaceholder` and an `ImageOutput.ratio`
  pre-load hint.

## 0.1.0-rc.33

### Minor Changes

- 909442f: Embed tokens and plugin route callers gain a `share` scope (file previewers on a share page); `FilePreviewArgs` is a union on `source` (`conversation` | `share`), with the shared fields exported as `FilePreviewArgsBase`.

## 0.1.0-rc.32

### Patch Changes

- 089ee76: Image generation contract on `model-provider@2`: `ModelProvider.generateImage`, `ModelInfo.imageGeneration`, the `refusal` model error kind, `pickImageSize` / `validateImageGenerateResult` (which also checks the result's `usage`: whole non-negative token counts and `outputImages`), the `image` model call purpose with its request and response hook payloads, `ctx.models.generateImage`, and `kind: "image_generation"` in `permissions.models`.

## 0.1.0-rc.31

### Minor Changes

- 429e837: Stage durable permission operation admission, fresh native operation facades and validated protocol adapters. Protocol activation remains gated on the coordinated caller and background migration.
- 9777d14: Replace the local policy's `mode` with a version-2 owner ceiling (`ownerCeiling: {fullAccess,
  restrictedProjectReach}`): old `mode: auto` converts exactly to Full allowed with OS-user reach,
  `mode: sandbox` to neither; `start` converts once under the policy lock and any write converts.
  The strict reader only trusts a version-2 file. New `capybara-device ceiling show|set`: setting
  needs both fields, narrowing applies directly, widening needs `--yes` or a confirmed prompt.
  Stage authenticated owner reports for protocol 3: the `owner-report.json` sequence sidecar,
  `parseOwnerCeilingReportV3`, and the report on policy frames, policy answers and applied policy
  statuses; a staged `policy` op may only narrow the owner ceiling and reconciles live work before
  answering. Protocol 2 and its `mode` summary are unchanged.

### Patch Changes

- 2256b24: The device hello can carry the host's OS boot identity (`bootId`; SDK `DEVICE_BOOT_ID_RE`,
  `isDeviceBootId`): `capybara-device` reports Linux's `boot_id` or macOS's boot session UUID (nothing
  otherwise) on the active and the staged hello. The kernel records it per machine from
  authenticated hellos only (a hello without one clears it); a local legacy retirement obligation keeps the boot its machine last
  reported and resolves once a current machine of the device (a re-login counts) reports another boot
  (the computer restarted). An obligation without a recorded boot never resolves by itself; the same
  boot from a new credential, a stale or replayed boot and a revoked machine are no evidence. A local device waiting for that restart
  answers `device.restart_required` ("Restart this computer to finish the upgrade").
  One whose computer never reported a boot identity answers `device.replace_required` (delete the
  device and connect the computer as a new one).
- Complete dormant managed output transport with strict positional ranges, authenticated connection capacity negotiation, and original admitted execution grant provenance. Protocol 2 remains active pending the coordinated runtime cutover.
- 54efba6: The restricted Linux launcher (`linux-sandbox.py` in `SANDBOX_RUNTIME_SOURCE`) makes itself
  non-dumpable (`PR_SET_DUMPABLE 0`) as its first statement, so a same-uid process outside the
  operation (another session's Full-access work, with no Yama) can no longer ptrace the launcher,
  supervisor or broker, nor read its `/proc/<pid>/mem`, `environ` or `fd`. A launcher already traced
  at that point reports restricted unavailable. The restricted command stays dumpable after its own
  execve (the broker reads its memory). The launcher digest changes, so consumers restage it.
  
  The permission conformance gains an optional fixture hook, `inspect.outside(program, args)`, that
  runs a program as the device user outside every operation; when present, the harness proves that
  the parent of a restricted command refuses `PTRACE_ATTACH`, `mem` and `environ` to it.
- a9626ee: Restricted Linux exec now brokers every filesystem write and refuses the mandatory write denies:
  `linux-sandbox.py` grants the command read access only to its write roots in Landlock, and each
  write-capable open, create, mkdir, mknod, unlink, rename, link, symlink, truncate and metadata
  change (and pathname UNIX binds) is performed by the broker on its own no-follow resolution from
  the pinned descriptors; openat2 is refused. New exports (`isSandboxWriteDenied`, `isSandboxMoveDenied`,
  `SANDBOX_MANDATORY_WRITE_DENIES`, `SANDBOX_GIT_ALLOWED_DIRECTORIES`, `SANDBOX_GIT_ALLOWED_FILES`,
  `SANDBOX_GIT_DENIED_INTERNALS`, `SANDBOX_PROTECTED_PATH_NAMES`) are the one write policy the
  launcher, `native-files.py` (roots with `denyWrites: true`) and consumers share: shell startup,
  git-global, `.envrc`, `.npmrc`, editor and agent files; inside any `.git` (submodule and worktree
  gitdirs included) only git's ordinary internals; no `HEAD` file outside `.git` (bare-repository
  lookalikes) and no repository forged inside git's own subtrees; hook-manager files (husky,
  pre-commit, lefthook, overcommit, simple-git-hooks, `.githooks`) denied; nothing moved out of a
  protected name; names compared after NFKC and full case folding, identical in TypeScript
  (`sandboxFoldName`'s table) and Python.
  git's `index.stash.<n>`, `packed-refs.new` and `MERGE_AUTOSTASH` are allowlisted internals. A
  brokered FIFO open no longer pins a broker thread. The launcher also accepts `nativeFd`, a verified descriptor of the native helper (exec mode).
  New digests: `linux-sandbox.py` b17b714a445912508d5082598af42960df550387c4a73b379561af19b0b45c87,
  `native-files.py` 09a78c9bb7264ad6a1fe3b1aadd4c0f489192dc47c903c7fcc42fdf405590b42.
- fe24223: Staged device protocol 3 gains the private `bindInstance` lifecycle request and its strict answer
  parser (`BindInstanceRequestV3`, `BindInstanceResultV3`, `DeviceRuntimeIdentityV3`). The kernel
  allocates each instance generation from a durable per-device high-water mark (no reuse after a
  deleted row, a clock rollback or two creates in one millisecond), commits an awaiting binding for a
  local instance and installs its runtime report only from the verified post-commit bind answer. A
  bound hello re-reports only the installed identity; a changed identity stops admission, and a
  changed environment resets Full consent. A reconnect no longer resets Full consent because stored
  roots came back in another key order. Protocol 2 stays active.

## 0.1.0-rc.30

### Patch Changes

- d5d0e76: Adds the `lightbox` theme token (the dimmed ground behind the image viewer), overridable by themes
  like the other color tokens.

## 0.1.0-rc.29

### Minor Changes

- 9c0d52e: `ctx.net.fetch` (`ExtensionNet`): the kernel's guarded HTTP client for URLs a person supplied
  (connector endpoints, org-overridable base URLs): https only, private / loopback / link-local
  addresses refused unless a super admin allowed the internal endpoint for the org (`opts.orgId`),
  redirects never followed. A refusal is a `NetDeniedError` (`code`, `host`, and `status` for a
  refused redirect); detect it with `isNetDeniedError`, never `instanceof`.
  `ConnectorOpenArgs.orgId` and `orgId` in the `Connector.inspect` args (both required) are the org
  the session or preview serves.
  Plugin authors: `ctx.net` needs a kernel that ships it; a plugin that calls it raises its
  manifest's minimum `sdk` to this release.

## 0.1.0-rc.28

### Patch Changes

- 7c91383: The restricted Linux launcher documents a known limitation: `/proc` stays readable, so a restricted
  command can read the cmdline of a concurrent Full command of the same uid; Landlock cannot narrow
  `/proc` to the command's own tree without breaking ordinary tools. Comment only; the launcher's
  digest changes.

## 0.1.0-rc.27

### Minor Changes

- c122975: `model-provider@1` is removed before 0.1.0 (no plugin provides it): the SDK drops
  `ModelProviderV1`, `ModelInfoV1`, `ModelRequestV1`, the `@1` constant
  `MODEL_PROVIDER_EXTENSION_POINT`, the deprecated `ModelInfo.capabilities.effort` and
  `ModelRequest.effort`; `EXTENSION_POINTS["model-provider"].majors` is `[2]`, so the kernel refuses
  to load a plugin providing `@1`, and its `@1` adapter is gone. `MODEL_PROVIDER_EXTENSION_POINT_V2`
  stays the constant to provide. The conformance suite in `@capybara-hq/testing` runs only `@2`
  targets: `ConformanceTarget` no longer has `contract` (drop `contract: 2`; `plugin` is required).
  The kernel's model list cache keys no longer carry the contract major.
- 303e6fb: Add the restricted Linux launcher and syscall broker (`linux-sandbox.py`, Landlock plus a seccomp
  notification broker) to `SANDBOX_RUNTIME_SOURCE` (version 2). Landlock rules, broker checks and the
  native helper share the consumer's pinned root descriptors; roots are never reopened by pathname.
  Its probe reports restricted unavailable on unvalidated architectures (only aarch64 is validated;
  x86_64 has a reviewed table awaiting real-kernel evidence), Landlock ABI below 6 or a missing seccomp
  listener. Restricted none/allowlist listens on loopback only; UNIX sockets are stream/seqpacket
  with pathname connect/bind confined to the write roots in every network kind; a lost supervisor's
  closed session is ended by the consumer's `reap`. Metadata reads outside the roots stay visible.
  Shipping the bytes is not a provider claim.
  
  Add `runSandboxPermissionConformance` to `@capybara-hq/testing`: an actual-provider permission
  suite (positive controls, sibling/symlink/protected-path and network denials, Full controls, both
  overlap orders, component/root swaps, mutable syscall pointers, loopback-only binds, UNIX sockets
  outside the roots under every network kind, cancellation and narrowed scopes).
- 4c9cc0c: Remove the deprecated UI `place` key, `PLACE_SLOTS`, `UiPlace`, `slotRefOf` and `aliasOf` from the
  plugin SDK: a UI contribution names its `slot`, which is now required. `resolveUiSlots` no longer
  returns `deprecatedPlace`, and `capybara-plugin check` drops the `ui-place-deprecated` rule.

### Patch Changes

- d522c01: `ModelRequest` gains an optional `purpose` (`"compaction"` on a conversation summary call). The
  compaction request is identified by it instead of a `CAPYBARA_COMPACTION` marker in the system
  prompt, so real providers no longer receive the marker; model-fake keys its summary reply on it.
- 874b346: The Linux restricted launcher now reports restricted support on x86_64 as well as aarch64. The
  real-kernel conformance suite passed on an x86_64 GitHub runner (Linux 7.0, Landlock enabled,
  Docker's builtin seccomp profile) with every mechanism test required to run.
- 794a77c: The SDK's doc comments are English (they were partly Chinese). Meaning and rules are unchanged; only the text of the doc comments shipped in the published declarations changes.

## 0.1.0-rc.26

### Minor Changes

- 325fe78: ContentBlock: a `file` block for attachments the model only references (never sent to a
  provider), `size` on the media blocks, and the optional `ObjectStore.uri` for an unsigned object
  identifier.

## 0.1.0-rc.25

### Minor Changes

- 5408b24: Export an immutable, hashed Python 3 native-file helper source bundle and a fixture-owned ordinary
  native API conformance harness. The helper preserves read/write/stat/list/scan semantics using
  supplied pinned root descriptors. Each conformance invocation receives a fresh operation.
  
  These exports establish portable native API compatibility only. They do not declare restricted
  runtime support or provide a Linux launcher, network broker, or full permission conformance suite.
- 5408b24: Require exact-reference positional reads of retained background output, with bounded raw-byte slices and committed snapshot positions independent of terminal tail summaries.
- 5408b24: Add immutable operation, owner browsing, trusted preparation and supervised background contracts with optional provider factories. Export strict, bounded scope/reference parsers and distinct tagged validation, denial, unsupported-permission and unknown-outcome errors. Existing device protocol v2 and provider method signatures remain unchanged.

### Patch Changes

- fb9afe0: Carry current mode ceilings on local stat and readFile requests so project context loads before
  any command and reads cannot inherit a stale wider command decision. Device protocol v2 requires
  a matching kernel and device upgrade; existing credentials and device files remain valid.

## 0.1.0-rc.24

### Minor Changes

- ed795c4: A device answers which directories it can read, so the kernel can keep a device's projects itself.
  
  `DeviceOp` gains `list` (`DeviceListArgs` `{ path, limit, limits }`: one directory's entries,
  sorted by code unit, at most `MAX_DEVICE_LIST_ENTRIES`, with `truncated`, or null for a path that
  does not exist) and `scan` (`DeviceScanArgs` `{ base, limits }`: the directories at most
  `MAX_DEVICE_SCAN_DEPTH` levels below `base` that hold `.git` or `AGENTS.md`, at most
  `MAX_DEVICE_SCAN_RESULTS`, as `DeviceProjectCandidate` `{ path, suggestedName }`). Both carry the
  kernel's current ceiling (`DeviceRequestCeiling`, `{ mode }`) and are answered in the mode it gives.
  Entry names are never `.` or `..`; `isDir` follows symbolic links (a dangling link is `false`, and
  so is a link whose target the request's mode cannot reach);
  paths are absolute and checked with `validateSandboxPathShape`; a `suggestedName` obeys
  `isDeviceProjectName` (`MAX_DEVICE_PROJECT_NAME_LENGTH`). A device announces both with the new
  `projects` feature, and the kernel sends them only to a device that did. A path the request's mode
  cannot reach is an error, never null; a missing scan `base` answers `[]`. `scan` includes `base`
  itself, follows no symbolic links, enters no hidden directories and never the directories named in
  the new `DEVICE_SCAN_SKIPPED_DIRS` (any depth: `node_modules`) or `DEVICE_SCAN_SKIPPED_BASE_DIRS`
  (directly under `base`: `Library`), keeps descending past a hit, does not return a directory whose
  basename is not a valid name (but still walks below it), and keeps the first results by path in
  code-unit order. It visits directories breadth-first, each level in code-unit order of path with
  `base` first (an unreadable directory counts as a visit), and stops after `MAX_DEVICE_SCAN_DIRS`
  (500) visits, so every provider answers the same for a huge tree.
  `isDeviceProjectName` also refuses `.`, `..` and leading or trailing whitespace. `DeviceHello` gains
  `home?: string`, the owner's home directory. `SandboxProvider` gains optional
  `list(h, path, { limit, limits, signal })` and `scan(h, base, { limits, signal })` with the same
  results; a provider without them offers no projects, and its conversations stay in free mode.
  
  The device keeps no project list: the policy summary carries no projects and there are no project
  operations; a device's projects live in the kernel.

## 0.1.0-rc.23

### Patch Changes

- 220a782: Breaking for route authors: every `permissions.http` entry declares `access` (`public`, `embed`,
  `member` or `admin`) instead of `public?: boolean`. A route handler is called with the caller the
  kernel resolved (`ctx.http.route(method, path, (req, caller) => ...)`, `RouteCaller`); `member` and
  `admin` routes mount under `/plugins/<name>/orgs/:orgId<path>`, `embed` routes live under `/ui/`,
  and an embed contribution's `path` must be declared as a `public` GET. An `embed` caller carries the
  token's `exp` (Unix seconds), so a long-lived handler can end when the token does. The
  `@capybara-hq/testing` fixtures declare access. `capybara-plugin check` fails a manifest whose route
  has no valid `access`, and plugin import refuses it. Existing deployments must re-approve every
  extension that declares routes, because the approved permissions change.

## 0.1.0-rc.22

### Minor Changes

- caa4575: Auto mode replaces the sandbox tiers. `SandboxLimits` now carries `mode` (`auto` / `sandbox`) and
  `network` (`{ kind: "open-public" | "allowlist", hosts }`) instead of tiers, egress and allowlists;
  the device protocol reports a `mode` feature and a `{ mode, allowedDomains }` policy summary, and
  the policy op may only narrow to `sandbox`. `ModelCallPurpose` and `UsagePurpose` gain `review`.
  Removed: `SandboxTier`, `SANDBOX_TIERS`, `isSandboxTier`, `compareTiers`, `tierAtMost`, `minTier`,
  `DEV_HOSTS`, `UNSANDBOXED_NOT_ALLOWED_MESSAGE`, `DeviceRemoteGrants`, and the old limit fields
  (`egress`, `allowHosts`, `tier`, `defaultTier`, `allowUnsandboxed`, `devHosts`). A provider that
  ignores the new fields runs as an allowlisted sandbox.

## 0.1.0-rc.21

### Patch Changes

- f78281b: A connector template and a custom connector can carry `git: { hosts: [{ host, username }] }`, the
  git hosts the connector's credential serves in sandboxes. Adds `GitSourceSchema`, `parseGitSource`,
  `validateGitSource` and `GIT_HOST_USERNAMES`; `validateConnectorTemplate` checks the field.

## 0.1.0-rc.20

### Minor Changes

- 76828c0: Device policy ops carry an op id. The device protocol's `policy` op now requires `opId` (non-empty,
  no `:`, at most 128 characters); the new `policyStatus` op asks a device what became of an op id
  (`applied`, `refused`, `started` or `unknown`, with its policy summary now); a hello may carry
  `recentOps`, the outcomes of the latest 100 policy ops; the new feature `policyOpId` announces all
  three. `capybara-device` logs each policy op in `policy-ops.json` next to `policy.json` (`started`
  before the change, then `applied` or `refused`; the last 100 kept), answers a repeated op id from
  that log without applying it again, and reports the log in every hello. The kernel sends its op id
  with each `policy` op.
  
  The SDK's hello parser keeps one `recentOps` entry per op id (the last one listed). `capybara-device`
  keeps a refusal's message in the log cut to 500 characters, never logs an applied op as refused
  when releasing the policy lock fails after the write, and keeps an op the log already says was
  applied as applied.

## 0.1.0-rc.19

### Minor Changes

- da677b6: context@1, conversation source, lifecycle hooks: the `context@1` extension point and provider types,
  `ToolSpec.sources` with `ToolCallContext.source`, `ownerAccountId` and `role`, and the observe-only
  mounts `org.member_removed`, `agent.deleted` and `org.deleted`.

## 0.1.0-rc.18

### Patch Changes

- 67e6ad5: A local OS-sandboxed device now kills what a foreground command leaves running (`server &`,
  `nohup …`) when the command ends, by its process group and by a per-command marker for processes
  that left the group. Inside the sandbox no later command could signal them, so they leaked. A
  background task launch, whose command starts with the new `BACKGROUND_LAUNCH_LINE`
  (`@capybara-hq/plugin-sdk`), keeps what it starts. The `Bash` description tells the model to use
  `run_in_background` for servers and watchers.
- e76028b: ScheduleCalendar: the scheduled task runs of a week or a month (time grid with a now line, three blocks side by side then +N, a dense lane, 6 × 7 month cells, the phone agenda, roving keyboard focus, loading, empty and load-failed states); the layout.calendar-* sizes and the ink / fail on hover and selected contrast pairs (also in the SDK's theme readability check)

## 0.1.0-rc.17

### Patch Changes

- 8471657: A local policy change made on the machine (`capybara-device policy ...` while the service runs, a
  flipped localhost proxy guard, a new tier ceiling) reaches the deployment at once: the device
  pushes its new summary in a `policy` frame (new in the device protocol), and the kernel stores it
  as it stores the hello's, so the device page and the next `device_paths` line show it.
- a3ca5ef: The super admin sets the platform's sandbox levels (`sandbox.tiers.max`, `default`,
  `allowUnsandboxed`) on the admin settings page (`PUT /api/v1/admin/settings` `sandboxTiers`). A field
  set in the startup config (env, file or Nacos) wins and is read-only there; an API token or the
  Platform tool may only lower them. The dev hosts preset (`DEV_HOSTS`) adds `storage.googleapis.com`,
  where Playwright's Chromium download (Chrome for Testing) is served from.

## 0.1.0-rc.16

### Minor Changes

- 2682d5f: Agent templates turn skills off with `disallowedSkills` (`<plugin>:<name>`, `<plugin>:*` or a bare
  `<name>`, at most 64; `isDisallowedSkillRef`) instead of selecting them: `selectedSkills` is
  removed. Creating an agent from a template turns those skills off and lists every name in `skills`
  as carried or unavailable; saving an agent as an org template writes its off-list.
- 2e52ca1: Network asks: `ExecResult.network` reports the hosts a command was refused and the layer that
  refused them (`parseOpResult("exec")` keeps the valid entries, at most 20, and drops a malformed
  report); the device hello may carry `features` and a local policy summary; a new device op `policy`
  edits a device's allowed domains; exec args may carry run or task `grants`; `SandboxActor.runId`;
  the `approval` card gains `scopeLabels` and the `skipped` state.
- 8fa0e32: Sandbox tiers: `SandboxTier` (`strict` < `dev` < `open`), `SANDBOX_TIERS`, `isSandboxTier`,
  `compareTiers`, `tierAtMost`, `minTier` and the dev hosts preset `DEV_HOSTS`. `SandboxLimits`
  requires `tier` and `devHosts` and may carry `defaultTier` and `allowUnsandboxed` (local exec args:
  whether the command may run without a sandbox; absent = no), with the refusal text
  `UNSANDBOXED_NOT_ALLOWED_MESSAGE`; `SandboxProvider` gains the optional
  `update(h, limits, signal)` and `limitsApplyAt`. Device protocol: the local policy summary replaces
  `network` with `tier` (absent = follows the org), `effectiveTier`, `isolation`, `localhost` and
  `unixSockets`; the hello feature `tiers`; the `policy` op takes `tier` (null = follow the org) and
  `isolation: "sandbox"` instead of `network`. `DeviceNetworkMode` is removed.
- 95fc4b0: Skills are on by default and pinning is gone. Every skill on in an org is on for every agent unless
  the agent's new `disabledSkills` turns it off (a plugin's skills by name, a whole plugin as `"all"`
  including skills it gains later, or a skill without a plugin by id); builtin skills, the agent's
  own and its shared skills cannot be turned off. `skills.orgSkills` and `skills.pinned` are removed
  from the agent definition (refused on save; migration 0116 rewrites every agent version), run start
  no longer injects pinned skill bodies (an old conversation gets a "Pinned skills removed" notice),
  and `agent.pinned_invalid` is gone. A sub-agent template's `skills` become one logged line telling
  the child to load them with `Skill` first. `plugin.json` `skills[].pinned` and the import confirm's
  `pinnedSuggestions` are removed; the skill APIs drop `suggestPinned`, `entryBytes` and
  `tokenEstimate` and the library list gains `builtin`; the Claude Code import reports a
  `session_start_hook` warning instead of a pin hint. The Platform tool's `agents.create` /
  `agents.update` take `disabledSkills`, and `platform.me` lists the agent's skills.

## 0.1.0-rc.15

### Minor Changes

- ac35f95: Bootstrap manifest entries may be `builtin: true`: builtin in the catalog, imported after the
  extensions load (so they may ship skills), and a failure does not stop the start

## 0.1.0-rc.14

### Minor Changes

- 6a4ffff: New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
  `stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
  (`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
  it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.

## 0.1.0-rc.13

### Minor Changes

- 7423fa7: Question cards can be skipped and say a text reply works. `ChannelCard` kind `question` gains the
  state `skipped` (the person sent a message instead of answering) and `textReply?: "plain" |
  "mention"` (pending cards: the person may answer by replying in the DM, or in the group thread
  mentioning the bot). `questionRenderableInline(form, { textReply })` accepts a field with
  `allowOther` when the card has `textReply` (draw no Other button: Other is a plain reply), also for
  multi-select. `renderCardAsText` writes the hint line and the skipped label; channel plugins use
  `questionTextReplyHint` and `questionStateLabel` for the same copy (an unknown state returns itself).

## 0.1.0-rc.12

### Patch Changes

- bae65fe: Channel connections choose their inbound mode when they are created. The config UI hint
  `inboundModes` (connection level, top-level fields) ties a field to inbound modes: forms draw it
  only in those modes and require it there, and the kernel refuses a create, config change or mode
  switch that leaves a required field empty (`extension.config_invalid`). `inboundModeFields` and
  `missingInboundModeFields` read the hint. `POST /channels` takes `inboundMode`;
  `GET /channels/schema/:plugin` says whether webhook inbound is usable (`inbound`). A connection name
  nobody typed yet is reported unresolved as `no_name`. The fake-im fixture's `webhookToken` is
  webhook-only. 新建渠道 sends the guide's mode, follows it with the credential fields, and shows
  less noise before save.

## 0.1.0-rc.11

### Minor Changes

- f172ba6: Built-in elements carry the public `data-cap-part` hooks of the `UI_PARTS` catalog (`owner` is now a
  list of files, since one part can be drawn by several components); the design package adds
  `DecorationLayer`, `ReplaceableFrame` and `SafeModeBanner`, the `decoration` layering token,
  `Sidebar` `brand` and `AppShell` `capState` (`data-cap-state`). `check:ui-parts` enforces the hooks.
- 460567f: The `client` section of the plugin extension (`PluginClientSection`, `validateClientSection`,
  `CLIENT_LIMITS`, `CLIENT_ASSET_TYPES`, `CLIENT_API_VERSION`) and `suggestedAppearance` in
  `plugin.json` (`SuggestedAppearance`, `appearanceIssues`). `extension.client` needs
  `permissions.client: true` and the reverse.
- 107a004: Component contributions: `kind: "component"` in the manifest `ui`, listed in the new
  `permissions.ui.components`, which needs the new `permissions.client: true`.
  `validateUiContributions` checks both directions, refuses an id in more than one of
  `views` / `embeds` / `components` and a component with a `path`. `UiView` gains `data` (a
  `JsonValue`), accepted only by `validateUiView(view, { component: true })`, at most
  `UI_LIMITS.componentDataBytes` (32768) bytes of JSON.
- 25e6ef3: The UI slot catalog gains the `component` kind, single (replaceable) slots with `cardinality`,
  `replaceable` and `builtin`, and the slots `shell.brand`, `shell.overlay`, `conversation.empty`
  and `conversation.composer.frame`.
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.
- 5d464ce: The client stylesheet rule is one function in the SDK: `clientCssProblem` (with `wrapClientCss`, the
  `@layer extensions` wrap the packer stores). `capybara-plugin pack` runs it on the file as it stores
  it and the kernel's import runs it on the stored bytes, so a plugin that packs cleanly imports
  cleanly: a broken `url(` fragment, a bad url token or a brace that would end the
  `@layer extensions` block early is refused at pack time (`client-css-remote`), not only at import.
  The packer no longer loads the kernel for this.

### Patch Changes

- c4b4f6f: Applying a suggested appearance at org level reports `from` as the value in effect (the org's own
  entry, else the platform's) with `followsPlatform`, and pins nothing when the org follows a
  platform that already uses the suggestion. Replacements are listed and applied in plugin.json
  order (recorded at import in `catalog_item_versions.appearance_order`, since the jsonb manifest
  does not keep key order; the item detail and the org extension list show them in that order). A
  second ref to one slot is skipped as `not-eligible`, and `parsePluginManifest` refuses it
  (`shell.brand` and `shell.brand@1` in one `suggestedAppearance.replacements`).
- f2786a6: At org level, applying a suggested appearance judges the followed platform default theme by its
  eligibility: a stored default that is no longer eligible renders the built-in, so applying the
  plugin's theme is reported as a change. `permissions.client: true` without a client section is
  reported as "permissions.client is true but extension.client is missing".
- ec5f411: `validateClientSection` refuses an asset path with a segment outside `[A-Za-z0-9._-]` (such as a
  literal `%2e%2e`, which the kernel's exact-key delivery never serves) and an asset without a file
  name before its extension (`.png`). `validateUiView` refuses component view `data` that JSON would
  silently drop or rewrite (functions, NaN or Infinity, `undefined` in an array, Maps, Dates, cycles);
  an `undefined` object property is still accepted. A `permissions.client` without a client section
  is reported with the same plain text as the forward case.

## 0.1.0-rc.10

### Minor Changes

- aa81e5a: Setup checks contract: an extension registers the live rows of its setup guides with
  `ctx.setup.check(id, { place, run })` during `setup`, each id listed in the new
  `permissions.setupChecks` (`SETUP_CHECK_ID_RE`, at most 32; ids with `:` stay the kernel's).
  `run` gets the org, the extension's effective config, the locale, the mode, an abort signal and the
  target: a channel connection with its config, or a connector with its ids and OAuth client id
  (never the client secret or a member's token). Results are `ok` / `failing` / `unknown` with plain
  text `reason` and `fix` (en required, zh optional, 300 / 500 characters) and no details field;
  `validateSetupCheckResult` returns a fresh copy or why it is invalid. `SETUP_CHECK_LIMITS` holds
  the run limits. A check never writes, passes `signal` on, does not retry and never puts a secret
  in its result.
- 2219734: Setup guides v2: a guide is a Markdown document `guides/<id>.md` (optional `guides/<id>.zh.md`)
  declared in `plugin.json` `setupGuides` as `{ id, place, template? }`. The SDK adds the place
  registry (`channel-connection`, `connector-template`; modes, audiences, typed variables), the
  parser (`parseSetupGuide`: title, `::: mode` / `::: audience` sections, `::check` lines, titled
  code fences), the validator (`validateSetupGuide`, including zh parity), the renderer
  (`renderSetupGuide`: substitution into the parsed tree, link policy, raw HTML as text, blocks) and
  the drift hash (`setupGuideHash`, code blocks and check lines only). The v1 steps-and-files format
  and its helpers are removed.

### Patch Changes

- 70a50f5: Add the `setup` agent docs topic: how an agent helps a person through a plugin's setup guide with
  the `setup` operations, and what stays with the person (secrets, OAuth consent, the guide ack).
  
  The `plugin-format` and `extensions` topics describe v2 setup guides (Markdown documents, places,
  sections, check lines) and setup checks (`ctx.setup.check`, `permissions.setupChecks`).

## 0.1.0-rc.9

### Minor Changes

- d495d7d: The `init` message to an embed carries `context` as `EmbedInitContext`, narrowed on `scope`: an org
  embed gets `{ scope: "org", orgId, conversationId? }`, a platform page of the admin console
  `{ scope: "platform" }` (no `orgId`).
- 18defa0: `platform.page` contributions are served to super admins on org-less routes under
  `/api/v1/admin/ui/` (`contributions`, `views/:plugin/:id`, `actions/:plugin/:id`,
  `embeds/:plugin/:id/token`, `stream`): the extension must be running (no org enablement applies)
  and gets the platform's deployment config. `UiRenderArgs` / `UiActionArgs` become unions narrowed
  on `scope`: the platform variant has `role: "superAdmin"` and no `orgId`. `EmbedClaims` gain
  `scope: "org" | "platform"` (`orgId` absent exactly for the platform scope); a platform token
  verifies only for a `platform.page` contribution while the account is still an active super admin,
  and an org token never verifies for one. `ctx.ui.invalidate` takes no `orgId` for a `platform.page`
  contribution (refreshing the admin console's stream) and throws when one is given.
- 0a35407: Add the UI slot catalog (`UI_SLOTS`, `uiSlot`, `parseSlotRef`, `PLACE_SLOTS`, arrangement keys).
- cf93278: The org UI routes gate every contribution by its slot: the slot's `minRole` (`org.settings.section`
  admin and above, `org.page` member and above, conversation and agent slots any member), then its
  scope (a readable conversation; an agent the caller can read in this org). `platform.page` is never
  listed or served through an org route. `GET /orgs/:orgId/ui/contributions` takes `?slot=` and lists
  `slot` and the resolved `after` anchor instead of `place`, ordered by extension name, then manifest
  order. Views, actions and embed tokens take `agentId` for `agent.detail.section`; embed claims carry
  it, and `ctx.ui.verifyEmbedToken` returns null when the current role no longer meets the slot's
  `minRole`. `UiRenderArgs` gains `slot`, `scope` and `agentId`; `EmbedClaims` gains `agentId`.
- 199f895: UI contributions name a slot (`slot: "conversation.panel"`, optionally `@<n>`, plus `after` for
  slots with anchors); `place` stays accepted as a deprecated input. `validateUiContributions` now
  covers only structural problems, and the new `resolveUiSlots` drops a contribution to an unknown
  slot or version instead of failing the extension. `normalizePlace` is removed.

### Patch Changes

- ec79610: One name: devices. The program says device everywhere: `credential.json` holds `deviceId` (a file
  from an older version is unusable: run `capybara-device logout` and log in again), the default
  directory is `~/capybara-device/<deviceId>`, the sign-in follows the kernel's `device_sign_in.*`
  error codes, and `status` prints `device`. SDK doc comments say device instead of environment.

## 0.1.0-rc.8

### Minor Changes

- c1c7b0f: Theme file format: `parseThemeFile`, `ThemeFileSchema`, `THEME_LIMITS`, `themeIdOf` and the
  `themes` field of `plugin.json` (a plugin may consist of themes only).
  A parsed theme holds only the file's own values; `mergeThemeSchemes` merges it onto the current
  built-in tokens (skipping overrides the built-ins no longer know), and
  `parseThemeFile(id, json, { readability: false })` re-reads a version already in a catalog without
  judging its readability again.
- ff5e3bf: Add theme asset checks: `sanitizeThemeSvg` (strict, namespace-aware SVG sanitizer that re-serializes
  the parsed tree), `checkWoff2`, `checkPng` and `validateThemeAssets`.
- 00e742e: Add `THEME_FONTS` (the built-in font stacks, generated from the design tokens) and the stored-theme
  re-validation helpers `canonicalThemeValue`, `isThemeFontFamily` and `isThemeAssetPath`.
- 0158d0c: Add the theme token allowlist (`THEME_TOKENS`, `THEME_OVERRIDABLE`, `THEME_CONTRAST`, `THEME_SEPARATION`) and `checkThemeReadability`, with the color math (`contrastRatio`, `oklabL`, `compositeOver`) moved into the SDK.

## 0.1.0-rc.7

### Minor Changes

- 09dea3e: A connector template file may say `"defaultEnabled": false`: the template then starts switched
  off in every org, even where its plugin is on, until an org admin switches it on, and while off it
  creates no connector and needs no org input (no 需要配置). Ignored for a builtin plugin and for a
  template the super admin gave its own scope.
- 60ce217: IM approval cards show what the web shows, never the raw call input: the approval card's
  `inputPreview` now carries one line, the tool's confirmation summary in the card language (a
  Platform operation's `summary`), else the tool's title and key argument (`Title: arg`), redacted
  and at most 300 characters; the full input stays behind the card's web link. `renderCardAsText`
  labels the line Summary / 摘要 and leaves it out when it is empty.
- 5ec789c: IM time zone and language per person: channel@1 `InboundSender` gains optional `timeZone` (IANA)
  and `locale` (`zh` / `en` or a BCP 47 tag). The kernel records on an IM `user_message` the
  platform's zone (when valid), else the account setting, else the org default, and the platform's
  language (`zh` / `zh-*` Chinese, any other tag English), else the UI language of the person's most
  recent web message in the org, else the org's `locale`. Any message without a language uses the
  latest web language the same way, and run start falls back to the author's settings for a message
  from an older log. The fake channel's sender profile takes `timeZone` and `locale`.
- 2435645: A `marketplace.json` entry may carry `icon`: an absolute `https://` URL whose path ends in `.svg` /
  `.png`, or a `./<path>.svg|png` inside a git marketplace's repository (read at the refreshed
  commit). Display only; the SDK exports `marketplaceEntryIcon`, `MARKETPLACE_ICON_RE` and
  `MARKETPLACE_LIMITS.iconBytes` (the plugin icon limit), and the JSON Schema has the field.
- ebe127f: OAuth connectors work with Slack-like token endpoints. A token response with `token_type: "user"`
  (Slack's `oauth.v2.user.access`) is accepted and sent as `Authorization: Bearer`, like `Bearer`;
  an `oauth_code` / `oauth_client` auth preset may list more accepted types in `tokenTypes`, and
  any other type is still refused (`unsupported_token_type`). A token endpoint error reported as
  HTTP 200 with `{ "ok": false, "error": … }` (or an `error` and no token) is a refusal with that
  code, like a 400: `invalid_refresh_token`, `token_revoked` and `token_expired` join `invalid_grant`
  in deleting the person's connection so they are asked to reconnect, transient codes such as
  `ratelimited` count as unavailable, and other codes keep the credential.
- d6fd4a9: `plugin.json` gains `setupGuides`: setup material a plugin ships for a place (`channel-connection`
  first), with localized plain-text steps and template files (`yaml` / `json` / `text`, optionally
  one per mode). The SDK exports the places, their modes and variables, the limits,
  `setupGuidePlaceholders`, `unknownSetupGuidePlaceholders`, `setupGuideModes`,
  `setupGuideFileProblem` and the pure renderer `renderSetupGuideText` (`{{name}}` placeholders, no
  other syntax; values escaped per language).

### Patch Changes

- c85f0b6: Connector templates shipped `"defaultEnabled": false` show up correctly in previews. Moving one
  from its own scope back to following its plugin lists the orgs it turns off in. A platform update
  no longer asks for input on an added template that is shipped off. An update that changes
  `defaultEnabled` on a template lists, for each org without a switch of its own, the template
  under `needsConfig` (now on) or under the new `turnedOff` (now off, with the agents using it and
  the connectors it keeps). OAuth hardening: an auth preset's `tokenTypes` refuses `DPoP`, and a
  token endpoint's HTTP 200 with RFC 6749's `temporarily_unavailable` or `server_error` counts as
  unavailable instead of a refusal.
- 3cbf6e8: Kernel-generated IM text speaks the person's language, not the org's: `/new`, `/env`, bind prompts
  and card-click replies use the sender's platform language, else the bound person's latest web
  message language, else the org's; delivered cards and notices use the language recorded on the
  conversation's latest user message (in a group thread, the person who triggered the run).
  `ChannelSendArgs.locale` carries that language to the extension.

## 0.1.0-rc.6

### Minor Changes

- c505b45: Add `SandboxRoots`, `DEFAULT_SANDBOX_ROOTS` and `rootsOf`, an optional `roots` on `SandboxHandle`, and the device protocol v1 frames with `parseDeviceFrame`.

### Patch Changes

- ebbfeb5: Sandbox tools use the instance's real paths: `validateSandboxPath`, `skillSandboxDir`,
  `skillSandboxPath` and `renderSkillBody` take an optional instance root, `validateSandboxPathShape`
  checks a path without its roots, and device protocol roots must be clean absolute paths; the
  kernel builds every model-visible path from the held instance's roots, tool descriptions say "the
  workspace directory", and each conversation records its environment's directories in an
  `environment_paths` system line on its first sandbox call and whenever they change.

## 0.1.0-rc.5

### Patch Changes

- f31ec88: Agent docs topics are titled "Authoring: ..." and the docs check catches both "in the code, not in the docs" and "in the docs, gone from the code".

## 0.1.0-rc.4

### Minor Changes

- 4a92acb: Model kinds and display fields on `ModelInfo`, an optional `embed` on `ModelProvider`, `{ orgId, config }` call options, `validateEmbedResult`, and an `embedding` usage purpose whose conversation fields are optional.
  
  `ctx.models.embed` / `describe` for extensions that declare embedding purposes in
  `permissions.models` (no longer reserved): the kernel resolves the org's model for the purpose,
  splits batches by `maxBatch`, validates results, records a `model_usage` row per call and delivers
  it through `usage.report` with purpose `embedding`. Each batch is limited by the new hot config
  `models.embedTimeoutMs`; `embed` takes an optional per-call `signal`. `capybara-plugin check` reports `ctx.models`
  without `permissions.models` as `perm-models` (was `perm-reserved`).
  
  `ctx.models.embed` fires the `model.request` hook once per call, before anything is sent, so policy
  hooks (DLP) see the texts sent to embedding vendors. `ModelRequestHookPayload` is now a union:
  `ModelCallRequestHookPayload` (steps, compaction, titles, `WebFetch`; the former interface) or
  `EmbeddingRequestHookPayload` (`purpose: "embedding"`, `orgId`, `extension`, `embeddingPurpose`,
  `provider`, `model`, `input`, `dimensions?`, `inputType?`, no conversation fields); narrow on
  `purpose` before reading `request`. A policy denial rejects the call with the new error code
  `model.hook_denied` (403; an extension route that lets it escape answers 403, not 500), writes a
  `hook.denied` audit row and records no usage. `model.response` does not fire for embeddings.

## 0.1.0-rc.3

### Minor Changes

- f222ff8: Agent templates describe a whole agent: `selectedSkills`, `connectors` (a connector template of the
  plugin, or a described need), `subagents` (general, template types, inline types), `modelRef`,
  `quickActions` and `instructionFiles`, all optional with limits; existing files parse unchanged.
  A connector entry may carry `policies` (tool name to `ask` / `deny`); an inline sub-agent's
  `tools` is optional (absent = all of the agent's tools, `[]` = none).
  A sub-agent dispatch resolves a template's `selectedSkills` names without pinning them.
- 7c8d05e: Extension points list the majors the kernel accepts (`EXTENSION_POINTS[name].majors`). The kernel
  refuses a plugin that provides an unsupported major (such as `sandbox@1`) with
  `extension.unsupported_extension_point` and asks it to upgrade.
- 2a12327: Marketplace entries accept `deprecated: true | { reason? }` (SDK `MarketplaceEntry.deprecated`,
  normalized by `marketplaceEntryDeprecation`; JSON Schema regenerated). A maintainer sets it by hand
  on a published version's entry; `capybara-plugin marketplace --write` keeps it, and the `--base`
  integrity rules ignore it. The kernel returns `deprecated` on marketplace entries, never reports a
  deprecated version as newer or as an item's latest marketplace version, picks the newest stable
  non-deprecated compatible version when an import names none, and refuses importing or requesting a
  deprecated version with 409 `marketplace.entry_deprecated`. The market lists show the newest stable
  version on each row (prereleases fold into 其他版本 unless no stable version can be imported) and
  list deprecated versions under 其他版本 as 已废弃, with the reason, not importable.
- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- fddab56: Add `orgAccess(schema, "readonly" | "override")` and `orgAccessOf`: a deployment config field can allow an org to override it per call. `configJsonSchema` publishes the level as `x-org`, and `validateConfigUi` refuses `x-org` outside top-level deployment fields and on secrets marked `readonly`.
  
  Every call the kernel makes for an org carries the extension's effective deployment config for that org as `config` (optional in the types, so older extensions compile): `web-search@1` / `web-fetch@1` `search` / `fetch` args and `configured(orgConfig, config)`, `directory@1` `listMembers` args and `configured(orgConfig, config)`, `ToolCallContext`, `UiRenderArgs` (and so `UiActionArgs`), `FilePreviewArgs`, and a third hook handler parameter `call: HookCall` (`{ config }`).
- 99a00cd: Platform and org layering: org admins can switch off `all` plugins and components, deployment config
  fields carry org levels with per-org copies and an effective config delivered to every org-bound
  extension call, and org admins can turn off single extension tools.
- 2fb7d41: The SDK ships agent docs (`agent-docs/`: platform concepts, plugin format, skills, agent and
  connector templates, tool naming, writing an extension, one topic per extension point), served by
  the kernel's `AgentDocs`. `ExtensionPointInfo` gains `description`, and `package.json` is an
  exported subpath. `check:agent-docs` keeps the generated field tables in step with the schemas.
- 6b4da7f: `sandbox@2` replaces `sandbox@1`: a provider makes an environment's file system
  (`createFileSystem`, `destroyFileSystem`, `destroyFileSystemByName`, `FileSystemGoneError`) apart from
  its instances, which attach to it and may be destroyed while the files stay; `create` takes an
  optional `image` (without it the provider uses its own published image); skill paths carry a
  digest (`/skills/<name>@<digest12>/`).

## 0.1.0-rc.2

### Minor Changes

- 0ec51d1: Config UI hints: `ui(schema, hints)` attaches presentation hints (labels, help, widgets, options,
  sections, array items, presets, secrets drawn per item) to an extension config schema;
  `configJsonSchema` turns a config schema into the JSON Schema for forms (`x-ui`, `x-secret`,
  `x-hot`, titles from labels, no values under secrets) and `validateConfigUi` checks the hints.
  `secret()` now merges with existing meta. `plugin.json` accepts `extension.configSchemas`. The
  kernel's config JSON Schema now comes from the SDK (`hot` is emitted as `x-hot`).
  
  Compatibility (pre-1.0 ruling): a plugin packed by the new plugin-tools that declares config
  carries `extension.configSchemas`, which an older kernel's strict section parser refuses
  ("unrecognized key") rather than through the SDK range. Kernel and plugins move together before
  1.0, so upgrade the kernel before importing such plugins.
- 8892d50: Add the `web-search@1` and `web-fetch@1` extension points (`WebSearchProvider`, `WebFetchProvider`, `WebProviderError`, `isPublicHostname`), `ExtensionPointInfo.selection`, and the `web_fetch` model call purpose. A `web-fetch@1` provider that fetches from inside the deployment must refuse non-public addresses after DNS resolution (documented on `WebFetchProvider`).

## 0.1.0-rc.1

### Patch Changes

- 8bf0b04: The builtin tools take Claude Code's names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
  `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`, `ToolSearch` and `Agent`
  (formerly `sandbox_bash` … `sandbox_deliver`, `skill_load`, `skill_write`, `ask_user`,
  `read_tool_output`, `tool_search` and `agent`). Every description, error and system text that names
  a builtin uses the new names; a request recorded before the rename is rebuilt with the old texts,
  so it replays with no drift. Several parameters are renamed as well (see the builtin tool
  parameters changeset).
- 32580d3: Model-visible tool keys of connectors are `mcp__<slug>__<tool>` and those of extensions
  `plugin__<plugin>__<tool>` (aligned with Claude Code). The SDK exports `parseToolKey`,
  `connectorToolKey`, `extensionToolKey`, `ParsedToolKey` and `BUILTIN_TOOL_NAME_RE`; hook payloads'
  `toolKey` carry the new keys, so an extension that matches keys should use `parseToolKey`.
