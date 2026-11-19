# Desktop client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository it runs under the `wave-planned-subagent-development` skill.

**Goal:** Ship the official Capybara desktop app (Electron, macOS first) in the new repository
`capybara-hq/clients`, plus the core changes it needs. The app loads a deployment's web, signs in
through the system browser, and connects the machine as a local device that runs as a login
service, with keep-awake.

**Architecture:**
- **Core (`capybara-hq/core`).** Four pieces:
  - Kernel: `platform.name`, a public `GET /api/v1/meta`, and the app sign-in routes (authorization
    code + PKCE, Redis codes, ordinary web sessions).
  - `@capybara-hq/plugin-sdk`: types for the desktop capabilities.
  - `packages/device`: a control socket, keep-awake and JSON outputs.
  - `apps/web`: the browser consent page, a browser-only sign-in button, 「连接本机」 and the 本机
    section.
- **Clients (`capybara-hq/clients`).**
  - A pnpm monorepo: `packages/shell` (pure logic) and `apps/desktop` (Electron).
  - The desktop's main process does all privileged work; the preload exposes only the Shell
    environment.
  - The device runs as the existing login service, on a bundled Node with the published device
    package.
  - The app talks to it through `capybara-device` commands and the control socket.

**Tech Stack:**
- Core: TypeScript, NestJS + Fastify, ioredis, Kysely / PostgreSQL, Next + TanStack Query, vitest.
- Clients: Electron (main process on Node 22), electron-builder, electron-updater, vitest,
  Playwright (`_electron`).

**Spec:** `docs/superpowers/specs/2026-11-07-desktop-client-design.md`. The Shell environment
contract is §9 of `docs/superpowers/specs/2026-11-19-mobile-layout-design.md`.

## Global Constraints

**Run and test rules (core):**
- Run tests from the repo root: `pnpm exec vitest run <path>`.
- A new kernel unit test joins `packages/kernel/test/unit-tests.json`. A new device test that
  needs a real OS sandbox or Docker joins `packages/device/test/os-tests.json`. Integration is the
  default.
- No fixed sleeps, no per-test timeouts.

**Code rules (core):**
- English comments and identifiers. Translate the comments and test titles you touch
  (`pnpm check:english-comments --base origin/main`).
- Kernel: explicit `@Inject`, `KernelConfigService`, `createZodDto` DTOs, writes in
  `@Transactional()`.
- Kernel Redis keys: every key has a TTL, and ids contain no `:` beyond the `capk:` prefix
  pattern.
- Every new `@Public()` route joins `PUBLIC_ROUTES` in `packages/kernel/test/identity/public-routes.test.ts`.
- Every new route gets an entry in `packages/kernel/src/platform/exclusions.ts`
  (`pnpm check:platform-ops`).
- Every new error code joins `packages/kernel/src/errors.ts`.
- Web: pages from `@capybara-hq/design` only; reads through `defineQuery`, writes through
  `useAppMutation`; zh and en messages in `apps/web/messages/{zh,en}.json` (`pnpm check:i18n`).
- Web: zh copy says 平台 / 智能体 / 设备 / 本机, never 企业 or the Latin word `agent`.
- Web: no read of `window.capybaraShell` outside `apps/web/src/lib/shell.ts` (`web-shell-access`
  check from the mobile plan).
- Changesets: `@capybara-hq/device` (minor, pre-release line), `@capybara-hq/plugin-sdk`
  (`pnpm gen:sdk-api`, `check:sdk-api-changeset`), `@capybara-hq/kernel` and
  `@capybara-hq/capybara` for kernel and image changes.

**Values (copy exactly):**

| Item | Value |
|---|---|
| Config | `platform.name`: string 1..64, optional, hot, env `CAPYBARA_PLATFORM__NAME` |
| Config | `auth.appRedirectUris`: string[], default `["capybara://auth/callback"]`, not hot, env `CAPYBARA_AUTH__APP_REDIRECT_URIS` |
| Meta | `GET /api/v1/meta` → `{ name: string \| null, icon: string \| null, protocols: { device: { min: 3, max: 3 } }, features: { localDevices: true, appSignIn: true } }`, header `cache-control: no-store` |
| App auth | Code `cap_ac_` + 32 random bytes base64url; Redis key `capk:app-auth-code:<sha256 hex>`, TTL 60 s, taken with `GETDEL`; PKCE `S256` only; `name` 1..64 printable characters; `appVersion` 1..32 characters |
| App auth | Callback query `code`, `state`, `iss` (= `http.publicUrl` without a trailing slash); deny callback `error=access_denied`, `state`, `iss` |
| App auth | Session `user_agent`: `Capybara Desktop/<appVersion> (<name>)` |
| App auth | Audit actions `auth.app_authorized` (detail `{ client, name }`), `auth.app_signed_in` (detail `{ client, name, sessionId }`) |
| App auth | Errors `app_auth.redirect_uri_invalid` 400, `app_auth.code_invalid` 400 (also wrong verifier, redirect mismatch, expiry) |
| App auth | Throttler `app-auth-token-ip`: 60 per `CREDENTIAL_WINDOW_MS`, by IP |
| Web | Consent route `/apps/authorize`, in the `(auth)` group |
| Device | Control socket `<stateDir>/control.sock`, mode 0600 |
| Device | Keep-awake `policy.json` field `keepAwake`: `"off" \| "while-busy" \| "connected"`, default `"while-busy"` |
| Device | macOS: `/usr/bin/caffeinate -i -w <runner pid>`. Linux: `systemd-inhibit --what=idle:sleep --mode=block --who=capybara-device --why="Capybara device is serving" sleep infinity` |
| Desktop | Capability keys `device@1`, `notify@1`, `openExternal@1`, `signIn@1`, `chrome@1` (`chrome@1` is the mobile spec's); Shell environment `version: 1`, `kind: "desktop"`, `platform: "macos"` |
| Desktop | Insets `{ top: 28, right: 0, bottom: 0, left: 0 }`. Controls `{ x: 0, y: 0, width: 80, height: 28 }` (measure on the built window). Fullscreen: top 0 and controls `null`, announced with `change` |
| Desktop | Working app id `com.capybarahq.desktop`; scheme `capybara`; redirect `capybara://auth/callback` |

**Exact UI copy (spec, verbatim):**
- Connect dialog: 「允许 <平台名称>（<host>）在这台电脑上运行命令吗？」, buttons 「允许」/「取消」.
- Consent page: 「在 <机器名> 上的 Capybara 桌面端登录 <平台名称>？」, buttons 「登录」/「取消」.
- Callback page: 「已返回 Capybara，可以关闭此页」.
- Sign-in button: 「在浏览器中登录」.
- Old deployment: 「该平台版本过旧」.
- Wake note: 「电脑曾休眠」.
- Settings and actions: 「本机」, 「连接本机」, 「添加平台」, 暂停 / 恢复 / 断开.
- English equivalents are written by the task that adds each key.

## Decisions this plan adds to the spec

Each is small and inside the spec's intent. The spec gets a one-line follow-up when the plan is
accepted.

1. **`appVersion` on authorize:** spec §6.5 records `Capybara Desktop/<version>` in the session's
   user agent but lists no version field, so authorize takes `appVersion`.
2. **Cancelling consent:** the page has no way to check the allowlist itself, so cancel posts the
   same authorize route with `deny: true`. The kernel validates the redirect URI and answers the
   `error=access_denied` redirect. No code is issued and no extra route is needed.
3. **Control socket path limit:** a socket path over 103 bytes (the macOS `sun_path` limit) or a
   state directory other users can read leaves the runner serving without the socket.
   `status --json` reports `control: "unavailable"` with the reason.
4. **Raising keep-awake from the CLI:** it asks on a TTY and needs `--yes` otherwise, mirroring
   `ceiling set`.

## Review Focus

1. **A replayed or stolen code:** a second exchange of the same code, an exchange with the wrong
   verifier and an exchange after 60 s all fail with `app_auth.code_invalid`. A disabled account
   gets no session. Task 3 pins all four.
2. **Open redirect through the consent page:** a `redirect_uri` not in `auth.appRedirectUris`
   shows an error on the page and never navigates; cancelling with a bad URI does the same.
   Tasks 3 and 6 test it.
3. **A second runner, or a socket left over from a crash:** a stale `control.sock` (nothing
   listens) is replaced at start. A live one belonging to another runner makes `start` refuse as
   today. A state directory that other users can read gets no socket. Task 4 pins all three.
4. **A path the socket cannot bind:** an `XDG_CONFIG_HOME` long enough that
   `<stateDir>/control.sock` exceeds 103 bytes. The runner keeps serving without the socket, and
   `status --json` says `control: "unavailable"` with the reason. Task 4 tests it.
5. **A page outside the rule:** a call from a frame that is not the top frame, a call from another
   origin, and a confirming call without user activation are all refused. A second confirming call
   while a dialog is open fails with `busy`. Task 13 pins each with a fake `senderFrame`.

---

## Cross-plan dependencies

| This plan needs | From | Used by |
|---|---|---|
| `CapybaraShell` types in `packages/plugin-sdk/src/shell-environment.ts` | Mobile layout plan | Tasks 2, 13 |
| `ShellEnvironmentScript`, `--cb-shell-inset-*` / `--cb-shell-controls-*`, drag regions in design CSS | Mobile layout plan | Window chrome (Task 13 only checks it in the window) |
| `apps/web/src/lib/shell.ts` with `useShellCapability(key)` and the `web-shell-access` check | Mobile layout plan | Tasks 7, 8, 9 |
| Platform icon service (`capybara.platform_icons`, `GET /api/v1/platform/icon/<purpose>?v=<sha256>`) | Mobile layout plan | Task 10 (meta `icon`) |
| `platform.name` and `GET /api/v1/meta` | **This plan, Task 1** | Mobile layout plan (manifest name) |

**Not implemented here:** the shared Shell environment pieces (types envelope, script, hook,
check). Where a task needs them and they are not merged yet, the task waits.

## Manual steps (maintainer)

- **M1 (done 2026-11-19):** create `capybara-hq/clients` (public, Apache-2.0).
  - Rulesets: `ci-ok` and `issue-linked` required, no pushes to `main`.
  - Labels; a CODEOWNERS file naming `@capybara-hq/maintainers`.
- **M2:** Apple signing credentials, stored as `capybara-hq/clients` secrets:
  - a Developer ID Application certificate (`.p12` + password);
  - a notarization API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`);
  - the team id.
  - Confirm the app id `com.capybarahq.desktop`.
- **M3:** release the core packages the clients depend on: merge the Version Packages PR that
  publishes `@capybara-hq/plugin-sdk` (Task 2) and `@capybara-hq/device` (Tasks 4, 5, 11). An
  agent with a standing release grant may do it.
- **M4:** the first signed release: run the clients release workflow (Task 16) and check the
  notarized DMG on a clean Mac.

---

## Wave plan (copy to the ledger)

| Task | Repo | Depends on | Files / areas | Risk | Wave | Phase | Review |
|---|---|---|---|---|---|---|---|
| 1 `platform.name` + `/api/v1/meta` | core | — | config/schema.ts, docs/config.md, new http/meta.controller.ts, api.module.ts, exclusions.ts, public-routes test | normal | 1 | D1 | batch |
| 2 Desktop capability types | core | — | plugin-sdk new shell-capabilities.ts, index.ts, sdk api, changeset | normal | 1 | D1 | batch |
| 4 Device control socket | core | — | device new control/*, activity.ts, start.ts, staged-connect.ts, server-ops.ts, commands/status.ts, index.ts | high | 1 | D2 | alone, most capable |
| 5 Device JSON outputs | core | — | device args.ts, commands/login.ts, commands/ceiling.ts, commands/service.ts | normal | 1 | D2 | batch |
| 12 Clients scaffold | clients | M1 | whole new repo skeleton | normal | 1 | D1 | own repo batch |
| 3 App sign-in routes | core | 1 | new identity/app-auth*.ts, identity.module.ts, api.module.ts, errors.ts, exclusions.ts, named-throttlers.ts, config/schema.ts, public-routes test | high | 2 | D1 | alone, most capable |
| 11 Device keep-awake | core | 4, 5 | device state.ts, new keep-awake.ts, wake.ts, commands/keep-awake.ts, args.ts, cli.ts, control/server.ts, server-ops.ts, README | normal | 2 | D2 | batch |
| 13a `packages/shell` | clients | 12 | packages/shell | normal | 2 | D1 | own repo batch |
| 6 Consent page `/apps/authorize` | core | 3 | web (auth)/apps/authorize, lib/app-auth.ts, messages | normal | 3 | D1 | batch |
| 13 Desktop main, address page, preload | clients | 13a, 2 (M3) | apps/desktop src/main/{index,profiles,windows,security,ipc}.ts, src/preload, src/address-page | high | 3 | D1 | alone, most capable |
| 7 Browser-only sign-in + shell accessors | core | 2, mobile `lib/shell.ts` | web lib/shell.ts (accessors), (auth)/login view, messages | normal | 4 | D1 | batch |
| 14 Sign-in through the browser | clients | 13, 3 | apps/desktop src/main/sign-in.ts, deep-links.ts, request-guard.ts | high | 4 | D1 | alone, most capable |
| 8 「连接本机」 + `/devices/link?org=` | core | 7 | web DeviceCreateDialog, (auth)/devices/link view, messages | normal | 5 | D2 | batch |
| 15 Dock icon, tray (D1), deep links, managed config | clients | 14 | apps/desktop src/main/{dock,tray,managed}.ts, deep-links.ts (open/connect routes) | normal | 5 | D1 | own repo batch |
| 16 Packaging, signing, updates | clients | 13 | apps/desktop electron-builder.yml, build/entitlements*.plist, src/main/updates.ts, .github/workflows/release.yml | normal | 5 | D1 | own repo batch |
| 9 本机 section, marks, notifications | core | 8 | web devices/[id] view, devices view, NewConversation picker, new components/ThisMachineSection.tsx, new use-shell-notifications.ts, messages | normal | 6 | D2 | batch |
| 17 Bundled Node + device service | clients | 16, 4, 5, 11 (M3) | apps/desktop scripts/bundle-node.ts, src/main/device/{cli,control,service}.ts | high | 6 | D2 | alone, most capable |
| 10 Docs and meta icon | core | 1, mobile icon | docs/architecture.md, skills, http/meta.controller.ts (icon) | normal | 7 | D1/D2 | batch |
| 18 `device@1` and native confirmations | clients | 17, 8 | apps/desktop src/main/device/{capability,connect,dialogs}.ts, preload capability list | high | 7 | D2 | alone, most capable |
| 19 Tray (D2), quit, i18n | clients | 17 | apps/desktop src/main/tray.ts, packages/shell i18n catalog | normal | 7 | D2 | own repo batch |
| 20 End-to-end smoke and acceptance | clients | 14, 18 | apps/desktop e2e/, packages/shell test fixture server | normal | 8 | D2 | own repo batch |

**Notes on the wave plan:**
- Waves count across both repositories. A clients task never shares files with a core task.
- Core web tasks 6 → 7 → 8 → 9 are serial because they share `apps/web/messages/*.json`.

---

## Core tasks (`capybara-hq/core`)

### Task 1: `platform.name` and `GET /api/v1/meta`

**Files:**
- Modify: `packages/kernel/src/config/schema.ts` (new top-level `platform` section)
- Modify: `docs/config.md` (`pnpm gen:config-docs`)
- Create: `packages/kernel/src/http/meta.controller.ts`
- Modify: `packages/kernel/src/http/api.module.ts` (register the controller)
- Modify: `packages/kernel/src/platform/exclusions.ts`
- Modify: `packages/kernel/test/identity/public-routes.test.ts`
- Test:
  - `packages/kernel/test/config/platform.test.ts` (unit, join `unit-tests.json`)
  - `packages/kernel/test/http/meta.test.ts`

**Interfaces:**
- Produces:
  - `cfg.platform.name: string | undefined`.
  - `export const MetaResponseSchema` (zod) and `type MetaResponse` in `meta.controller.ts`, with
    the shape of Global Constraints.
  - `MetaController.meta(): Promise<MetaResponse>`, where `icon` comes from
    `private iconUrl(): Promise<string | null>`, which returns `null` until Task 10.

- [ ] **Step 1:** Config tests.
  - `parse({}).platform.name` is `undefined`.
  - `parse({ platform: { name: "Example Corp" } })` keeps it.
  - A 65-character name and an empty string are rejected.
  - `CAPYBARA_PLATFORM__NAME=Example` reaches `platform.name`.
- [ ] **Step 2:** Meta tests (one app, through `app.inject`).
  - Without a session: 200, header `cache-control: no-store`, body
    `{ name: null, icon: null, protocols: { device: { min: 3, max: 3 } }, features: { localDevices: true, appSignIn: true } }`.
  - With `platform.name` set, `name` equals it.
  - The device range uses `DEVICE_PROTOCOL_VERSION` from the SDK.
- [ ] **Step 3:** Run `pnpm exec vitest run packages/kernel/test/config/platform.test.ts packages/kernel/test/http/meta.test.ts`.
  Expected: FAIL.
- [ ] **Step 4:** Implement.
  - Config field: `meta({ hot: true, description })`, per the `adding-config` skill.
  - Controller: `@Controller("api/v1/meta")`, `@Public()`, `@Get()`,
    `@Header("cache-control", "no-store")`; `name` from `KernelConfigService`.
  - Add `"GET /api/v1/meta"` to `PUBLIC_ROUTES`.
  - Add an exclusion: category `transport`, reason "Pre-sign-in discovery for native clients:
    platform name, icon and protocol ranges".
- [ ] **Step 5:** Run `pnpm gen:config-docs`, the two tests, `pnpm exec vitest run packages/kernel/test/identity/public-routes.test.ts`,
  `pnpm check:platform-ops` and `pnpm check:config-docs`. Expected: all PASS.
- [ ] **Step 6:** Add a changeset (`@capybara-hq/kernel`, `@capybara-hq/capybara`: patch), then
  commit:
  `git commit -m "feat(kernel): add platform.name and the public /api/v1/meta"`.

### Task 2: Desktop capability types in the SDK

**Files:**
- Create: `packages/plugin-sdk/src/shell-capabilities.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (export it)
- Modify: the generated SDK API report (`pnpm gen:sdk-api`)
- Create: `.changeset/<name>.md` (`@capybara-hq/plugin-sdk`: minor)
- Test: `packages/plugin-sdk/test/shell-capabilities.test.ts` (type-level `expectTypeOf`, plus
  the key constants)

**Interfaces:**
- Produces (types only, plus key constants; no runtime logic):

```ts
export const SHELL_CAPABILITY_KEYS = {
  device: "device@1", notify: "notify@1", openExternal: "openExternal@1", signIn: "signIn@1",
} as const;
export type KeepAwakeMode = "off" | "while-busy" | "connected";
export type DeviceConnection = "starting" | "online" | "offline" | "draining" | "stopped";
export type ThisMachineStatus =
  | { state: "not_connected" }
  | { state: "connected_elsewhere"; origin: string }
  | { state: "connected"; deviceId: string; orgId: string; mode: "os" | "docker";
      connection: DeviceConnection; offlineReason?: string; serviceInstalled: boolean;
      keepAwake: { mode: KeepAwakeMode; held: boolean; unavailable?: string };
      lastWakeAt?: string };
export interface RunningOperationView {
  tag: string; conversationId: string | null; accountId: string | null;
  isolation: "restricted" | "full"; startedAt: string;
}
export type ShellCallError = "busy" | "no_activation" | "cancelled" | "failed";
export interface DeviceCapabilityV1 {
  status(): Promise<ThisMachineStatus>;
  onStatus(listener: (s: ThisMachineStatus) => void): () => void;
  running(): Promise<RunningOperationView[]>;
  connect(input: { orgId: string; deviceId?: string }): Promise<"connected" | "cancelled">;
  pause(): Promise<void>;
  resume(): Promise<"resumed" | "cancelled">;
  disconnect(): Promise<void>;
  requestCeiling(input: { fullAccess: boolean; projectReach: "workspace" | "os-user" }): Promise<"applied" | "cancelled">;
  setKeepAwake(mode: KeepAwakeMode): Promise<"applied" | "cancelled">;
}
export interface NotifyCapabilityV1 { notify(input: { title: string; body: string; path?: string }): Promise<void>; }
export interface OpenExternalCapabilityV1 { open(url: string): Promise<void>; }
export interface SignInCapabilityV1 { start(): Promise<"signedIn" | "cancelled">; }
```

- Errors: a rejected promise carries `{ code: ShellCallError }`.

- [ ] **Step 1:** The test asserts the key constants and that `DeviceCapabilityV1["connect"]`
  returns `Promise<"connected" | "cancelled">`. Run it. Expected: FAIL (module missing).
- [ ] **Step 2:** Add the file and the export; run `pnpm gen:sdk-api`.
- [ ] **Step 3:** Run the test, `pnpm check:sdk-api`, `pnpm check:sdk-api-changeset` and
  `pnpm typecheck`. Expected: PASS.
- [ ] **Step 4:** Commit:
  `git commit -m "feat(plugin-sdk): add the desktop shell capability types"`.

### Task 3: App sign-in routes (high risk: authentication, PKCE, redirect allowlist)

**Files:**
- Modify: `packages/kernel/src/config/schema.ts` (`auth.appRedirectUris`, also in the `auth`
  `.default({...})` object); `docs/config.md`
- Create:
  - `packages/kernel/src/identity/app-auth.schemas.ts`
  - `packages/kernel/src/identity/app-auth.ts` (`AppAuthService`)
  - `packages/kernel/src/identity/app-auth.controller.ts`
- Modify:
  - `packages/kernel/src/identity/identity.module.ts`, `packages/kernel/src/http/api.module.ts`
  - `packages/kernel/src/errors.ts`, `packages/kernel/src/platform/exclusions.ts`
  - `packages/kernel/src/infra/throttler/named-throttlers.ts` (`app-auth-token-ip`, next to
    `device-token-ip`)
  - `packages/kernel/test/identity/public-routes.test.ts`
- Test:
  - `packages/kernel/test/identity/app-auth.http.test.ts`
  - `packages/kernel/test/identity/app-auth.unit.test.ts` (PKCE and URI helpers; join
    `unit-tests.json`)

**Interfaces:**
- Consumes:
  - `SessionService.create(accountId, { userAgent, ip })`;
  - `setSessionCookies` (`identity/cookies.ts`);
  - `clientMeta` (`identity/auth.controller.ts`);
  - `audit()` (`identity/audit.ts`);
  - `REDIS` (`infra/tokens.ts`).
- Produces:
  - `POST /api/v1/app-auth/authorize` (`@SessionOnly()`, CSRF header as for every session write).
    - Body `AppAuthorizeBody`:
      `{ client: "desktop", redirectUri, codeChallenge, codeChallengeMethod: "S256", state, name, appVersion, deny?: boolean }`.
    - Answer `{ redirect: string }`.
  - `POST /api/v1/app-auth/token` (`@Public()`, `@Throttled("app-auth-token-ip")`).
    - Body `{ code, codeVerifier, redirectUri }`.
    - Answer `{ account }`, with `cap_at` / `cap_rt` set.
  - Exported pure helpers in `app-auth.ts`:
    - `s256(verifier: string): string` (base64url SHA-256);
    - `buildRedirect(uri: string, params: Record<string, string>): string`;
    - `isAllowedRedirect(uri: string, allowed: readonly string[]): boolean` (exact string match).

- [ ] **Step 1: Unit tests.**
  - `s256` with the RFC 7636 appendix B vector: verifier
    `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` gives
    `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.
  - `isAllowedRedirect` is exact: no prefix match, no case folding.
  - `buildRedirect` keeps existing query parameters and encodes values.
- [ ] **Step 2: HTTP tests** (one app; a signed-in session via the test login helper).
  - `"authorize returns a redirect with code, state and iss"`: the code starts with `cap_ac_`;
    `iss` equals the public URL; audit `auth.app_authorized` with `{ client: "desktop", name }`.
  - `"authorize refuses an unlisted redirect uri"`: `capybara://evil` →
    `app_auth.redirect_uri_invalid`, and nothing is stored in Redis.
  - `"authorize refuses a personal token"`: answers `auth.session_required`.
  - `"authorize refuses plain and missing challenge methods"`.
  - `"deny returns error=access_denied without a code"`.
  - `"token exchanges once and sets session cookies"`:
    - `cap_at` / `cap_rt` are set and `GET /api/v1/me` works with them;
    - the session row has `user_agent` = `Capybara Desktop/1.2.3 (Ada's MacBook)`;
    - audit `auth.app_signed_in`.
  - `"a second exchange of the same code fails"` → `app_auth.code_invalid`.
  - `"a wrong verifier fails and burns the code"`: a later right verifier also fails.
  - `"a mismatched redirect uri fails"`.
  - `"an expired code fails"`: delete the Redis key, or move the clock if the code stores
    `expiresAt`.
  - `"a disabled account gets no session"`.
  - `"the redis key has a ttl of at most 60 s"`.
  - `"sign-out ends only the app session"`: a browser session of the same account still works
    after `/auth/logout` with the app's cookies.
  - `"the token endpoint is rate limited per ip"`.
- [ ] **Step 3:** Run `pnpm exec vitest run packages/kernel/test/identity/app-auth.http.test.ts packages/kernel/test/identity/app-auth.unit.test.ts`.
  Expected: FAIL.
- [ ] **Step 4: Implement.**
  - `authorize`:
    - check the allowlist and the method;
    - with `deny`, return the deny redirect;
    - otherwise generate the code;
    - `SET capk:app-auth-code:<sha256(code)> <json> EX 60 NX`, with json
      `{ accountId, sessionId, client, redirectUri, codeChallenge, name, appVersion }`;
    - write the audit row; return `buildRedirect(redirectUri, { code, state, iss })`.
  - `token` (a `@Transactional()` service method):
    - `GETDEL` the key **before** the transaction (one use);
    - compare `redirectUri`; compare `s256(codeVerifier)` with `timingSafeEqual`;
    - load the account and refuse a disabled one;
    - `SessionService.create` with the composed user agent and the request IP;
    - audit; the controller calls `setSessionCookies`.
    - Every failure answers `app_auth.code_invalid`.
  - Add both routes to `PUBLIC_ROUTES` (`token` only) and to the exclusions:
    - `authorize`: `human-only`, "A person consents in the browser to sign a native app in".
    - `token`: `transport`, "A native app exchanges a one-time sign-in code; nothing for an agent".
  - Add the config field, then `pnpm gen:config-docs`.
- [ ] **Step 5:** Run the tests, the public-routes test, `pnpm check:platform-ops`,
  `pnpm check:config-docs` and `pnpm check:kernel-conventions`. Expected: PASS.
- [ ] **Step 6:** Add a changeset (kernel, capybara), then commit:
  `git commit -m "feat(kernel): sign native apps in with an authorization code and PKCE"`.

### Task 4: Device control socket (high risk: local permissions)

**Files:**
- Create:
  - `packages/device/src/control/protocol.ts`, `packages/device/src/control/server.ts`,
    `packages/device/src/control/client.ts`
  - `packages/device/src/activity.ts`
- Modify:
  - `packages/device/src/commands/start.ts` (start and stop the server)
  - `packages/device/src/staged-connect.ts` (`onState` option)
  - `packages/device/src/server-ops.ts` (feed `RunningOperations` where an exec start and its exit
    are noted in the command log)
  - `packages/device/src/commands/status.ts` (live fields)
  - `packages/device/src/index.ts` (export the protocol types)
  - `packages/device/README.md`
- Test:
  - `packages/device/test/control-socket.test.ts`
  - `packages/device/test/activity.test.ts`
  - `packages/device/test/status.test.ts` (new cases)

**Interfaces:**
- Produces:
  - `controlSocketPath(stateDir: string): string`.
  - `type ControlRequest = { id: number; op: "status" | "running" | "subscribe" | "drain" | "stop" }`.
  - `type ControlResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: string; message: string } }`.
  - `type ControlEvent = { event: "status"; status: LiveStatus }`.
  - `interface LiveStatus { pid: number; version: string; url: string; orgId: string; deviceId: string; mode: "os" | "docker"; connection: "starting" | "online" | "offline" | "draining"; offlineReason?: string; since: string }`.
    Task 11 adds `keepAwake` and `lastWakeAt`.
  - `interface RunningOperation { tag: string; conversationId: string | null; accountId: string | null; isolation: "restricted" | "full"; startedAt: string }`.
  - `startControlServer(opts: { stateDir: string; status(): LiveStatus; running(): RunningOperation[]; drain(): void; stop(): void }): Promise<{ close(): Promise<void>; publish(s: LiveStatus): void } | { unavailable: string }>`.
  - `queryControl(stateDir: string, op: ControlRequest["op"], timeoutMs?: number): Promise<unknown | undefined>`
    (`undefined` when no runner answers).
  - `class RunningOperations { begin(op: RunningOperation): void; end(tag: string): void; list(): RunningOperation[] }`.
  - `StagedConnectOptions.onState?: (s: { connection: LiveStatus["connection"]; reason?: string }) => void`.
  - `status --json` gains `control: "ok" | "absent" | "unavailable"` and `live: LiveStatus | null`.

- [ ] **Step 1: Tests** (temp state dirs, mode 0700).
  - `"the socket is 0600 in an owner-only state dir"`.
  - `"a state dir readable by others gets no socket"`: `{ unavailable }` naming the mode; the
    runner keeps serving.
  - `"a stale socket file is replaced"`: nothing listens on it.
  - `"a live socket is not replaced"`: two servers on one dir, the second gets `{ unavailable }`.
  - `"a path over 103 bytes is unavailable"`.
  - `"status, running, drain and stop answer by id"`: drain and stop call the injected functions.
  - `"subscribe receives status events"`.
  - `"an unknown op answers ok false"`.
  - `"a malformed line answers an error and keeps the connection"`.
  - `"running never contains command text"`.
  - Status cases:
    - with a running fake server, `status --json` has `control: "ok"` and the live fields;
    - with no runner, `control: "absent"` and `live: null`;
    - the credential is never printed.
  - Start test (extend `start.test.ts`): the socket exists while serving and is removed after
    `stop`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/device/test/control-socket.test.ts packages/device/test/activity.test.ts packages/device/test/status.test.ts packages/device/test/start.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Server:
    - before listening, check the state dir with the same owner and mode check `readCredential`
      applies;
    - set `process.umask(0o077)` around `listen`, then `chmod 0600`;
    - for a stale file: try to connect, and only on `ECONNREFUSED` / `ENOENT` unlink a socket the
      user owns.
  - Protocol: JSON lines; one listener per connection.
  - `start`: build the status from the credential plus `onState`; close the server in the
    `finally`.
  - `status`: call `queryControl(dir, "status", 500)`.
- [ ] **Step 4:** Run the tests and `pnpm check:deps`. Expected: PASS.
- [ ] **Step 5:** Update the README (a new "Control socket" section: path, mode, ops, the
  `status --json` fields). Add a changeset (`@capybara-hq/device`: minor), then commit:
  `git commit -m "feat(device): add a local control socket with live status and running operations"`.

### Task 5: Device JSON outputs

**Files:**
- Modify:
  - `packages/device/src/args.ts` (`login --json`, `ceiling show --json`,
    `service status --json`)
  - `packages/device/src/commands/login.ts`, `packages/device/src/commands/ceiling.ts`,
    `packages/device/src/commands/service.ts`
  - `packages/device/README.md`
- Test:
  - `packages/device/test/args.test.ts`, `packages/device/test/login.test.ts`
  - `packages/device/test/ceiling-json.test.ts`, `packages/device/test/service.test.ts` (new
    cases)

**Interfaces:**
- Produces:
  - `login --json` writes one JSON object per line to stdout and implies `--no-browser`:
    - `{ "event": "verification", "url": string, "userCode": string, "expiresIn": number }`;
    - then `{ "event": "done", "deviceId": string, "orgId": string, "dir": string }` or
      `{ "event": "error", "code": string, "message": string }`.
    - Human lines go to stderr only.
  - `ceiling show --json` → `{ fullAccess: boolean, projectReach: "workspace" | "os-user", revision: number }`.
  - `service status --json` →
    `{ installed: boolean, loaded: boolean, running: boolean, pid?: number, runningVersion?: string, installedVersion?: string, nodePath?: string, binPath?: string, binExists: boolean }`.

- [ ] **Step 1: Tests.**
  - Parsing: `login --json` sets `browser: false`.
  - The login JSON sequence with the fake kernel, for: approved, expired → `device_sign_in.expired`,
    and denied.
  - `"login --json prints no credential"`.
  - Ceiling JSON shape.
  - Service status JSON: `binExists: false` when the plist's `bin` path is missing (the app moved).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement: an `emit` sink chosen by `--json`; reuse `plistBinPath` /
  `serviceBinPath` and `packageVersionAt`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** README and changeset, then commit:
  `git commit -m "feat(device): add JSON output to login, ceiling show and service status"`.

### Task 11: Device keep-awake

**Files:**
- Modify:
  - `packages/device/src/state.ts` (`Policy.keepAwake`, `DEFAULT_POLICY`, file validation)
  - `packages/device/src/args.ts`, `packages/device/src/cli.ts`
  - `packages/device/src/control/protocol.ts`, `packages/device/src/control/server.ts`
    (`LiveStatus.keepAwake`, `lastWakeAt`)
  - `packages/device/src/commands/start.ts` (wire both)
  - `packages/device/src/server-ops.ts` (deployment policy ops keep `keepAwake`)
  - `packages/device/README.md`
- Create:
  - `packages/device/src/keep-awake.ts`, `packages/device/src/wake.ts`
  - `packages/device/src/commands/keep-awake.ts`
- Test:
  - `packages/device/test/keep-awake.test.ts`, `packages/device/test/wake.test.ts`
  - `packages/device/test/policy-store.test.ts`, `packages/device/test/server-ops-v3.test.ts`
    (new cases)

**Interfaces:**
- Consumes: `startControlServer`, `LiveStatus` (Task 4); the `--json` sink pattern (Task 5).
- Produces:
  - `class KeepAwake { constructor(o: { platform: NodeJS.Platform; pid: number; spawn?: typeof spawn }); update(i: { mode: KeepAwakeMode; connected: boolean; busy: boolean }): void; state(): { mode: KeepAwakeMode; held: boolean; unavailable?: string }; dispose(): void }`.
    - It holds the assertion when `mode === "connected" && connected`, or when
      `mode === "while-busy" && busy`.
  - `class WakeDetector { constructor(o: { now?: () => number; monotonic?: () => number; thresholdMs?: number /* 30000 */ }); check(): string | undefined /* ISO wake time */ }`.
    - The runner calls `check()` from its existing liveness loop.
    - A wake writes `{ op: "wake" }` to `commands.log` and sets `lastWakeAt`.
  - CLI: `capybara-device keep-awake [show | off | while-busy | connected] [--yes] [--json]`.
    - Raising on a TTY asks `Keep this computer awake more often? [y/N]`.
    - Without a TTY, raising needs `--yes`. Lowering never asks.
    - The change is written under `policy.json.lock` and logged with `noteCliPolicyChange`.

- [ ] **Step 1: Tests.**
  - `"while-busy holds only while operations run"`: a fake spawn records
    `["/usr/bin/caffeinate", ["-i", "-w", "<pid>"]]` and is killed when busy ends.
  - `"connected holds while connected"`.
  - `"off never spawns"`.
  - `"linux uses systemd-inhibit"`: the exact argv of Global Constraints.
  - `"a spawn error is unavailable with the reason"`: nothing pretends.
  - `"dispose kills the holder"`.
  - `"a wall-clock jump over 30 s is a wake"`, and `"a small drift is not"`.
  - `"keepAwake defaults to while-busy and a bad value is refused"`.
  - `"raising without a tty needs --yes"`.
  - `"lowering applies without asking"`.
  - `"a deployment policy op keeps keepAwake"`.
  - `"status shows keepAwake and lastWakeAt"`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `busy` is `RunningOperations.list().length > 0`; the runner calls
  `update` on every begin, end and connection change. The policy re-read (`PolicyStore.current()`)
  applies a mode change without a restart.
- [ ] **Step 4:** Run the tests and `pnpm exec vitest run packages/device`. Expected: PASS.
- [ ] **Step 5:** README "Keep-awake" section. It states verbatim what cannot be prevented (spec
  §9.7: lid closed on battery without an external display, Sleep, critically low battery, thermal
  emergency, the Linux lid switch) and that the kernel sees a sleeping machine as offline. Add a
  changeset, then commit:
  `git commit -m "feat(device): keep the computer awake while the device serves"`.

### Task 6: Consent page `/apps/authorize`

**Files:**
- Create:
  - `apps/web/src/app/(auth)/apps/authorize/page.tsx` (thin server page) and `view.tsx`
  - `apps/web/src/lib/app-auth.ts` (`authorizeApp(body)`)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json` (namespace `appAuth`)
- Test: `apps/web/test/app-authorize-page.test.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/app-auth/authorize` (Task 3); `GET /api/v1/meta` (Task 1) for the
  platform name; the sign-in redirect helper `loginPathFor` that `/devices/link` uses.
- Produces: the page reads the query keys `client`, `redirect_uri`, `code_challenge`,
  `code_challenge_method`, `state`, `name`, `app_version`.

- [ ] **Step 1: Tests** (renderRouteWithCache, mocked fetch).
  - Signed out: redirect to sign-in and back.
  - Signed in: shows 「在 Ada's MacBook 上的 Capybara 桌面端登录 Example Corp？」 and the account.
  - 「登录」 posts the body and navigates to the returned redirect via `navigateBrowser`.
  - 「取消」 posts `deny: true` and navigates.
  - `app_auth.redirect_uri_invalid` shows an error and **never navigates**.
  - A missing parameter shows an error without calling the API.
  - After navigating, the page shows 「已返回 Capybara，可以关闭此页」.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/app-authorize-page.test.tsx`.
  Expected: FAIL.
- [ ] **Step 3:** Implement with `AuthPage`, `Card`, `KeyValue`, `Button` (the `/devices/link`
  layout); the write through `useAppMutation`.
- [ ] **Step 4:** Run the test, `pnpm check:web-ui` and `pnpm check:i18n`. Expected: PASS.
- [ ] **Step 5:** Commit:
  `git commit -m "feat(web): add the app sign-in consent page"`.

### Task 7: Browser-only sign-in and the shell accessors

**Waits for:** the mobile plan's `lib/shell.ts` and `useShellCapability`.

**Files:**
- Modify: `apps/web/src/lib/shell.ts` (typed accessors only; the module is the mobile plan's)
- Modify: `apps/web/src/app/(auth)/login/view.tsx`
- Modify: `apps/web/messages/{zh,en}.json` (`login.browserSignIn`)
- Test: `apps/web/test/login-shell.test.tsx`; the existing `apps/web/test/shell.test.ts` from
  the mobile plan (new cases)

**Interfaces:**
- Consumes: Task 2 types; `useShellCapability(key)` (mobile plan).
- Produces:
  - `useDeviceCapability(): DeviceCapabilityV1 | undefined`
  - `useNotifyCapability(): NotifyCapabilityV1 | undefined`
  - `useSignInCapability(): SignInCapabilityV1 | undefined`
  - each one `useShellCapability(SHELL_CAPABILITY_KEYS.x) as … | undefined`.

- [ ] **Step 1: Tests.**
  - With a fake `window.capybaraShell` offering `signIn@1`, the login page shows only
    「在浏览器中登录」: no form, no SSO buttons. A click calls `start()`.
  - Without it, the page is unchanged.
  - A capability that appears after mount (`change`) switches the page.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. On `cancelled` the page stays; an error shows the generic sign-in
  error copy.
- [ ] **Step 4:** Run the tests, `pnpm check:web-ui`, `pnpm check:i18n` and
  `pnpm check:web-shell-access` (the check's script name from the mobile plan). Expected: PASS.
- [ ] **Step 5:** Commit:
  `git commit -m "feat(web): sign in through the browser inside the desktop shell"`.

### Task 8: 「连接本机」 and `/devices/link?org=`

**Files:**
- Modify: `apps/web/src/components/DeviceCreateDialog.tsx` (the `LocalSteps` branch)
- Modify: `apps/web/src/app/(auth)/devices/link/page.tsx`, `view.tsx` (the `org` param)
- Modify: `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/devices.test.tsx`, `apps/web/test/device-link-page.test.tsx` (new cases)

**Interfaces:**
- Consumes: `useDeviceCapability()` (Task 7).

- [ ] **Step 1: Tests.**
  - With `device@1` and status `not_connected`, the 本地设备 branch shows a primary 「连接本机」
    above the terminal steps; a click calls `connect({ orgId })`.
  - `"connected"` resolves into the existing wait-for-new-device path; `"cancelled"` leaves the
    dialog as it was.
  - Status `connected` to this deployment shows that device's state and a link to its page.
  - `connected_elsewhere` shows the message and only the terminal steps.
  - `/devices/link?code=…&org=<id>` preselects that org and 新建设备 with the machine's name; the
    person still confirms with one click. An `org` the person is not in is ignored.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Status comes from `device.status()` / `onStatus` through a
  `defineQuery` keyed `["shell", "device-status"]`, invalidated by `onStatus`.
- [ ] **Step 4:** Run the tests, `pnpm check:web-ui` and `pnpm check:i18n`. Expected: PASS.
- [ ] **Step 5:** Commit:
  `git commit -m "feat(web): connect this machine from the desktop shell"`.

### Task 9: 本机 section, marks and notifications

**Files:**
- Create: `apps/web/src/components/ThisMachineSection.tsx`
- Create: `apps/web/src/lib/use-shell-notifications.ts`
- Modify: `apps/web/src/app/(app)/devices/[id]/view.tsx`, `apps/web/src/app/(app)/devices/view.tsx`
- Modify: `apps/web/src/components/conversation/NewConversation.tsx` (picker mark)
- Modify: the workspace layout that mounts app-wide hooks (`apps/web/src/app/(app)/layout.tsx` or
  its client shell)
- Modify: `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/devices-this-machine.test.tsx`, `apps/web/test/shell-notifications.test.ts`

**Interfaces:**
- Consumes: `useDeviceCapability()` and `useNotifyCapability()` (Task 7); `inboxQuery(orgId)`.

- [ ] **Step 1: Tests.**
  - On the page of the device that `status()` names, the section shows:
    - 「本机」 and the running list from `running()`;
    - 暂停 / 断开, or 恢复 when stopped;
    - the keep-awake choice (off / 运行时 / 始终), with what it cannot prevent;
    - 「电脑曾休眠」 when `lastWakeAt` is newer than the page's last view;
    - widening through `requestCeiling`, replacing the `CEILING_COMMAND` line.
  - On other devices, and without the capability, the page is unchanged.
  - The device list and the new-conversation picker mark the device 「本机」.
  - Notifications: a new inbox item calls `notify({ title, body, path })` once per item id while
    `document.visibilityState === "hidden"`; the same item never notifies twice; without
    `notify@1` nothing happens.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Actions go through `useAppMutation` and invalidate the shell status
  query. `"cancelled"` shows nothing.
- [ ] **Step 4:** Run the tests, `pnpm check:web-ui` and `pnpm check:i18n`. Expected: PASS.
- [ ] **Step 5:** Commit:
  `git commit -m "feat(web): show this machine and notify through the desktop shell"`.

### Task 10: Docs and the meta icon

**Waits for:** the mobile plan's platform icon service.

**Files:**
- Modify: `packages/kernel/src/http/meta.controller.ts` (`iconUrl()`)
- Modify: `packages/kernel/test/http/meta.test.ts`
- Modify: `docs/architecture.md`: `capybara-hq/clients` as an external app; `packages/device`
  gains the control socket and keep-awake.
- Modify:
  - `.agents/skills/writing-kernel-api/SKILL.md`: one line, app sign-in uses the ordinary session
    service.
  - `.agents/skills/writing-sandbox-providers/SKILL.md`: the control socket is local and owner-only.
- Modify: `docs/deploy/README.md` (connected devices: `platform.name`, `auth.appRedirectUris`)

- [ ] **Step 1:** Test: with a customised platform icon, `icon` is
  `/api/v1/platform/icon/app?v=<sha256>`, the same URL the manifest uses; with the default it is
  `null`. Run it. Expected: FAIL.
- [ ] **Step 2:** Implement `iconUrl()` with the mobile plan's icon service.
- [ ] **Step 3:** Docs edits, then run `pnpm verify`. Expected: ok.
- [ ] **Step 4:** Commit:
  `git commit -m "docs: desktop client in the architecture; meta returns the platform icon"`.

---

## Clients tasks (`capybara-hq/clients`)

The repository follows the organization's conventions:
- Conventional Commits; changesets for the app version;
- `issue-linked`; the synced skills `onboarding`, `contributing`, `reviewing-prs`;
- an `AGENTS.md`.

Tests: `pnpm test` (vitest). Main-process modules take their Electron objects as parameters, so
they test without Electron. `pnpm e2e` runs Playwright `_electron` on macOS CI.

### Task 12: Repository scaffold

**Waits for:** M1.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`,
  `vitest.config.ts`, `commitlint.config.js`, `.changeset/config.json`
- Create: `.github/workflows/ci.yml`: lint, typecheck, test on `macos-latest` and
  `ubuntu-latest`, plus a `ci-ok` aggregate.
- Create: `.github/pull_request_template.md`, `AGENTS.md`, `LICENSE` (Apache-2.0), `README.md`
- Create:
  - `packages/shell/package.json` (`@capybara-hq/shell`, private);
  - `apps/desktop/package.json` (Electron ≥ 35, so the main process runs Node 22);
  - `apps/desktop/brand.ts`, the only brand file:
    `{ productName: "Capybara", appId: "com.capybarahq.desktop", scheme: "capybara", icons: "build/icons", updateFeed: { provider: "github", owner: "capybara-hq", repo: "clients" } }`.
- Create: `.agents/skills/` synced from `capybara-hq/.github` (its sync script)

- [ ] **Step 1:** Add a smoke test `packages/shell/test/smoke.test.ts` (imports the package
  entry). Run `pnpm install && pnpm test`. Expected: PASS.
- [ ] **Step 2:** Run `pnpm lint && pnpm typecheck`. Expected: PASS. Open the first PR and
  confirm `ci-ok` runs. This PR must add `.github/workflows/ci.yml` with the `ci-ok` job: the
  repository's `main-quality` ruleset requires `ci-ok` and `issue-linked` with no bypass, so no
  PR merges until it exists (the gate workflows pr-event / cla / community are already on `main`).
- [ ] **Step 3:** Commit: `chore: scaffold the clients monorepo`.

### Task 13a: `packages/shell`

**Files:**
- Create in `packages/shell/src/`:
  - `address.ts`, `meta.ts`, `pkce.ts`, `deep-link.ts`, `sign-in-callback.ts`
  - `i18n/{zh,en}.json`, `i18n/index.ts`
- Create: `packages/shell/scripts/check-i18n.ts`
- Test: `packages/shell/test/*.test.ts`

**Interfaces:**
- Produces:
  - `normalizeAddress(input: string): { ok: true; origin: string; base: string } | { ok: false; reason: "invalid" | "insecure" }`.
    - Adds `https://` when there is no scheme, keeps the port and the path prefix.
    - `http` is allowed only for `localhost`, `127.0.0.1`, `::1`.
  - `fetchMeta(base: string, fetchFn: typeof fetch): Promise<Meta | { error: "unreachable" | "not_capybara" | "too_old" }>`.
    - `too_old` when `features.appSignIn !== true`.
    - It validates the shape of core Task 1.
  - `createPkce(): { verifier: string; challenge: string }` (32 random bytes, S256).
  - `parseDeepLink(url: string): { kind: "auth"; code?: string; error?: string; state: string; iss: string } | { kind: "connect"; address: string } | { kind: "open"; url: string } | null`.
  - `checkCallback(cb, pending: { state: string; base: string; createdAt: number }, now: number): "ok" | "unknown_state" | "wrong_issuer" | "expired" /* 10 min */`.
  - `t(locale: "zh" | "en", key: string, vars?: Record<string, string>): string`.

- [ ] **Step 1: Tests.**
  - Address: `capybara.example.com` → `https://capybara.example.com`.
    `http://localhost:3000` is ok; `http://10.0.0.5` is insecure; a path prefix is kept.
  - `fetchMeta`: each error kind.
  - `createPkce` against the RFC 7636 vector (inject the random bytes).
  - `parseDeepLink`: the auth callback, the deny callback, `connect`, `open`; a foreign scheme is
    `null`.
  - `checkCallback`: each result.
  - The i18n key-sync script fails when a key is missing in one language.
- [ ] **Step 2:** Run `pnpm --filter @capybara-hq/shell test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(shell): address, discovery, PKCE, deep links and i18n`.

### Task 13: Desktop main process, address page, preload (high risk: the page boundary)

**Files:**
- Create in `apps/desktop/src/main/`:
  - `index.ts`: single-instance lock, app lifecycle.
  - `profiles.ts`: JSON store in `userData`, atomic writes; profile =
    `{ id, base, origin, name, iconHash? }`.
  - `windows.ts`
  - `security.ts`: `webPreferences`, permission handler, navigation and `window.open` rules.
  - `ipc.ts`: the origin and frame check, the activation and busy gate.
- Create in `apps/desktop/src/preload/`: `index.ts`, `shell-environment.ts`
- Create: `apps/desktop/src/address-page/{index.html,address.css,address.js}` (served from
  `app://`, strict CSP, no `@capybara-hq/design`)
- Test: `apps/desktop/test/{profiles,security,ipc,shell-environment}.test.ts`

**Interfaces:**
- Consumes:
  - `CapybaraShell` (mobile plan's SDK types) and Task 2's capability types, from the published
    `@capybara-hq/plugin-sdk`;
  - `normalizeAddress`, `fetchMeta`, `t`.
- Produces:
  - `registerCapability(key: string, impl: Record<string, (...a: unknown[]) => unknown>, opts: { confirming?: string[] }): void`.
    It is main-side; the preload sees only keys and function names.
  - `guardIpc(event: { senderFrame: { origin: string; parent: unknown | null } }, profile: Profile): boolean`.
  - `isConfirmingCallAllowed(profileId: string, activationActive: boolean): "ok" | "busy" | "no_activation"`.
  - The Shell environment object:
    - `{ version: 1, kind: "desktop", platform, shellVersion, insets, controls, capabilities, on }`;
    - values from Global Constraints;
    - a `change` event on enter and leave fullscreen.
    - The preload injects it only when `location.origin === profile.origin` and the frame is the
      top frame.

- [ ] **Step 1: Tests.**
  - `guardIpc`: refuses a sub-frame, another origin, and an `app://` frame; accepts the top frame
    of the exact origin.
  - The gate: no activation → `no_activation`; a second confirming call while one is open →
    `busy`; the next call after the first resolves → `ok`.
  - Security: `webPreferences` has `contextIsolation: true`, `sandbox: true`,
    `nodeIntegration: false` and `webviewTag: false`.
  - Navigation and `window.open`:
    - a permission request from another origin is denied;
    - `window.open` to another origin goes to `shell.openExternal` (http and https only) and
      `javascript:` is refused;
    - a same-origin `window.open` opens a profile window.
  - Profiles: create, list, remove (clears the partition via an injected `session.clearStorageData`),
    the last-used profile.
  - Shell environment: `fullscreen` sets top 0 and controls `null` and emits `change`.
- [ ] **Step 2:** Run `pnpm --filter desktop test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Address page: one field, `normalizeAddress`, `fetchMeta`, then the name and icon.
    - It shows 「该平台版本过旧」 for `too_old`, then saves the profile and loads the deployment.
  - The window: `titleBarStyle: "hiddenInset"` with a fixed `trafficLightPosition`.
  - Capabilities in this task: `notify@1` (Electron `Notification`; a click focuses the window
    and navigates to a same-origin `path`), `openExternal@1`, `chrome@1` (`setAppearance` sets the
    window background).
- [ ] **Step 4:** Run the tests; then run the app manually against a dev kernel (`pnpm dev`) and
  check that `window.capybaraShell` exists on the deployment origin and not in `/plugin-ui`
  frames. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(desktop): main process, address page and the shell environment`.

### Task 14: Sign-in through the browser (high risk: authentication)

**Files:**
- Create in `apps/desktop/src/main/`:
  - `sign-in.ts`: pending entries, PKCE, opening the browser, the exchange.
  - `deep-links.ts`: `open-url` / `second-instance`, the `capybara://` registration, the router.
  - `request-guard.ts`: the `webRequest` block.
- Test: `apps/desktop/test/{sign-in,deep-links,request-guard}.test.ts`

**Interfaces:**
- Consumes:
  - `createPkce`, `parseDeepLink`, `checkCallback`;
  - core Task 3 routes; `registerCapability`.
- Produces:
  - `signIn@1.start()`;
  - `routeDeepLink(url: string): void`, which Task 15 extends for `connect` and `open`;
  - `blockInWindowSignIn(session, origin)`, which cancels `POST <base>/api/v1/auth/login` and
    `GET <base>/api/v1/auth/sso/*/start` from the profile's partition.

- [ ] **Step 1: Tests.**
  - `start()` opens the browser at `<base>/apps/authorize?client=desktop&redirect_uri=capybara%3A%2F%2Fauth%2Fcallback&code_challenge=…&code_challenge_method=S256&state=…&name=…&app_version=…`.
  - A callback with a matching `state` and `iss` triggers one exchange through the profile
    session's `fetch`, with `{ code, codeVerifier, redirectUri }`; the window reloads; `start()`
    resolves `signedIn`.
  - An unknown `state`, a wrong `iss`, or a callback after 10 minutes: no exchange.
  - A replayed callback: no second exchange.
  - `error=access_denied` resolves `cancelled`.
  - The exchange never writes tokens anywhere: assert no store call.
  - The request guard cancels both routes and lets everything else through.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `app.setAsDefaultProtocolClient(brand.scheme)` and
  `session.fromPartition(...).fetch` (cookies land in the partition).
- [ ] **Step 4:** Run the tests, then do a manual sign-in against a dev kernel with Task 3 and
  Task 6 merged. Expected: PASS; the window is signed in, and the sessions table shows
  `Capybara Desktop/<v> (<name>)`.
- [ ] **Step 5:** Commit: `feat(desktop): sign in through the system browser`.

### Task 15: Dock icon, tray (D1), deep links, managed configuration

**Files:**
- Create in `apps/desktop/src/main/`: `dock.ts`, `tray.ts`, `managed.ts`
- Modify: `apps/desktop/src/main/deep-links.ts` (`connect`, `open`)
- Test: `apps/desktop/test/{dock,tray,managed,deep-links}.test.ts`

**Interfaces:**
- Produces:
  - `updateDockIcon(profiles: Profile[], fetchIcon): Promise<void>`: exactly one profile with
    meta `icon` → `app.dock.setIcon`; otherwise the Capybara icon.
    - Accepts only a PNG of at most 1 MB; cached by the hash in the URL.
  - `readManagedConfig(): { profiles?: string[]; lockDeployments?: boolean; autoUpdate?: boolean; updateFeed?: string; connectThisMachine?: boolean }`,
    from the macOS managed preferences of `brand.appId`.
  - Tray: profiles, 「添加平台」, open window, quit.

- [ ] **Step 1: Tests.**
  - The Dock rule for one profile with an icon, several profiles, and no icon.
  - A non-PNG or an over-1-MB icon is ignored.
  - `connect` prefills the address page and never saves silently.
  - `open` focuses the matching profile only for its own origin.
  - With `lockDeployments`, 「添加平台」 is hidden and other addresses are refused.
  - The app menu's start-at-login item is off by default and calls `app.setLoginItemSettings`
    (spec §9.4).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(desktop): dock icon, tray, deep links and managed configuration`.

### Task 16: Packaging, signing, updates

**Files:**
- Create: `apps/desktop/electron-builder.yml`
  - target `dmg` + `zip`, `universal`, hardened runtime, `asar: true`;
  - `extraResources` for `device/` and `node/` (filled by Task 17);
  - `protocols: [capybara]`.
- Create: `apps/desktop/build/entitlements.mac.plist` and `apps/desktop/build/entitlements.node.plist`
  (`com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory` for the bundled Node)
- Create: `apps/desktop/scripts/fuses.ts`: `@electron/fuses` with `RunAsNode` off,
  `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off,
  `EnableEmbeddedAsarIntegrityValidation` on, `EnableCookieEncryption` on.
- Create: `apps/desktop/src/main/updates.ts` (electron-updater; managed `autoUpdate` /
  `updateFeed`)
- Create: `.github/workflows/release.yml`: build, sign and notarize with the M2 secrets, publish
  to GitHub Releases.
- Test: `apps/desktop/test/{fuses,updates}.test.ts`

- [ ] **Step 1: Tests.**
  - The fuses script config equals the list above.
  - `updates.ts` does nothing when managed `autoUpdate: false`, and uses `updateFeed` when set.
- [ ] **Step 2:** Run them. Expected: FAIL; then implement; then PASS.
- [ ] **Step 3:** Run `pnpm --filter desktop dist --mac --publish never` unsigned locally.
  Expected: a `.app` whose fuses read back as configured (`npx @electron/fuses read`).
- [ ] **Step 4:** Commit: `build(desktop): package, sign, notarize and update`.
- [ ] **Step 5 (maintainer, M4):** run the release workflow, then install on a clean Mac.
  Expected: Gatekeeper accepts it.

### Task 17: Bundled Node and the device service (high risk: code execution path, plist paths)

**Waits for:** M3 (published `@capybara-hq/device` with Tasks 4, 5, 11).

**Files:**
- Create: `apps/desktop/scripts/bundle-node.ts`
  - downloads the pinned Node 22 LTS for darwin-arm64 and darwin-x64, checks `SHASUMS256.txt`;
  - makes a universal binary with `lipo`, into `build/node/node`;
  - copies the exact `@capybara-hq/device` version from `node_modules` into `build/device/`,
    unmodified.
- Create in `apps/desktop/src/main/device/`:
  - `cli.ts`: run a device command, parse JSON lines.
  - `control.ts`: the control socket client, using the device package's exported types.
  - `service.ts`: install, start, stop, restart; reinstall when moved; restart after an update.
- Test: `apps/desktop/test/device/{cli,control,service,bundle}.test.ts`

**Interfaces:**
- Consumes: `ControlRequest` / `LiveStatus` / `controlSocketPath` (device Task 4); the JSON
  outputs (Task 5); the keep-awake command (Task 11).
- Produces:
  - `deviceCli(args: string[], o?: { onLine?: (obj: unknown) => void }): Promise<{ code: number }>`,
    which runs `<Resources>/node/node <Resources>/device/bin/capybara-device.mjs …`.
  - `controlClient(stateDir): { status(): Promise<LiveStatus | undefined>; running(): Promise<RunningOperation[]>; subscribe(cb): () => void; drain(): Promise<void> }`.
  - `ensureService(): Promise<"installed" | "kept" | "reinstalled">`:
    - reads `service status --json`;
    - reinstalls when `binExists` is false or `binPath` is under a different app bundle;
    - keeps a CLI-installed service.
  - `afterUpdate(): Promise<void>`: `service restart` when the service runs the app's copy.

- [ ] **Step 1: Tests.**
  - `cli.ts`: argv, environment (inherits `PATH` and `HOME`, never `ELECTRON_RUN_AS_NODE`), JSON
    line parsing; a non-JSON stdout line is ignored.
  - `ensureService`: each of the three results.
  - `afterUpdate`: restarts only the app's copy.
  - `bundle-node`: a wrong checksum fails the build; the copied device files hash equal to
    `node_modules`.
- [ ] **Step 2:** Run them. Expected: FAIL; then implement; then PASS.
- [ ] **Step 3:** Manual check on a Mac:
  - after `ensureService`, `launchctl print gui/$UID/top.capybara.device` shows the bundled node;
  - quitting the app leaves `capybara-device status --json` at `control: "ok"`.
- [ ] **Step 4:** Commit: `feat(desktop): run the device as a login service on the bundled Node`.

### Task 18: `device@1` and native confirmations (high risk: the confirmation gates)

**Files:**
- Create in `apps/desktop/src/main/device/`:
  - `capability.ts`: the `device@1` implementation.
  - `connect.ts`: the connect flow.
  - `dialogs.ts`: the native dialog texts and calls.
- Modify: `apps/desktop/src/main/ipc.ts` (register `device@1` when available)
- Test: `apps/desktop/test/device/{capability,connect,dialogs}.test.ts`

**Interfaces:**
- Consumes: Tasks 13, 17; `DeviceCapabilityV1` (Task 2); core Task 8 (`org=`).
- Produces: `device@1` per Task 2. Confirming functions: `connect`, `resume`, a widening
  `requestCeiling`, a raising `setKeepAwake`.

- [ ] **Step 1: Tests** (dialogs injected).
  - `device@1` is offered only on macOS or Linux, without managed `connectThisMachine: false`,
    and with meta `localDevices` and a device range containing the bundled program's protocol.
  - `connect`:
    - the native dialog text is the exact copy, with the platform name or only the host;
    - 「取消」 → `cancelled` and no `login`;
    - 「允许」 → `login --json --url <base>`;
    - the verification URL opens in a child window of the profile partition with `&org=<orgId>`;
    - `done` closes it, runs `ensureService` and `service start`, and resolves `connected`.
  - Connecting while logged in elsewhere asks to disconnect the first (`service stop`, `logout`)
    and stops on refusal.
  - `pause` → `drain`; `disconnect` → `service stop`; `resume` → dialog, then `service start`.
  - `requestCeiling`:
    - narrowing runs `ceiling set … --yes` with no dialog;
    - widening shows the device's `CEILING_WIDENING_TEXT` / `FULL_ACCESS_RISK_TEXT` (read from the
      bundled package's output, not copied) and applies only on yes.
  - `setKeepAwake`: lowering with no dialog; raising with the dialog, then
    `keep-awake <mode> --yes`.
  - Removing a profile while this machine is connected to it asks natively whether to disconnect
    and log the device out (spec §6.3); 「否」 keeps the device.
  - `status()` maps `status --json` + control to `ThisMachineStatus`. Origins are compared with
    `normalizeAddress`.
  - No function returns the credential: assert over every result.
- [ ] **Step 2:** Run them. Expected: FAIL; then implement; then PASS.
- [ ] **Step 3:** Manual check against a dev kernel with core Tasks 8 and 9: connect this machine
  from 新建设备 in one confirmation; the device page shows 本机 and the running list.
- [ ] **Step 4:** Commit: `feat(desktop): connect this machine with native confirmations`.

### Task 19: Tray (D2), quit, i18n

**Files:**
- Modify: `apps/desktop/src/main/tray.ts`
- Modify: `packages/shell/src/i18n/{zh,en}.json`
- Test: `apps/desktop/test/tray.test.ts`

- [ ] **Step 1: Tests.**
  - The tray icon state follows `LiveStatus`: not connected, online, offline, paused, busy.
  - The menu shows the running count, 暂停 / 恢复 / 断开 (resume through the same dialog),
    keep-awake, and the device page.
  - Quit never asks and never stops the service.
  - i18n keys are in sync.
- [ ] **Step 2:** Run them. Expected: FAIL; then implement; then PASS.
- [ ] **Step 3:** Commit: `feat(desktop): device state in the tray`.

### Task 20: End-to-end smoke and acceptance

**Files:**
- Create: `packages/shell/test/fixtures/fake-deployment.ts`: an HTTP server answering
  `/api/v1/meta`, `/apps/authorize`, `/api/v1/app-auth/token` (sets a cookie) and a page that
  prints `window.capybaraShell` keys.
- Create: `apps/desktop/e2e/smoke.spec.ts` (Playwright `_electron`)
- Create: `apps/desktop/e2e/README.md`: the manual acceptance list for a real Mac and a dev
  kernel.
  - Connect; the window closes and the device stays online; quit and it stays online.
  - Keep-awake while a long command runs (`pmset -g assertions` shows the assertion).
  - Lid-closed behaviour on battery (expected to sleep, then offline, then the wake note).

- [ ] **Step 1:** Smoke flow:
  - address → meta → the deployment page shows `capybaraShell` with `signIn@1`;
  - simulate the callback deep link → the exchange sets the cookie → reload shows signed in;
  - an iframe on the page does not see `capybaraShell`.
  Run `pnpm e2e`. Expected: PASS on `macos-latest`.
- [ ] **Step 2:** Commit: `test(desktop): end-to-end smoke and the acceptance checklist`.

---

## Phases

- **D1** (shell): core Tasks 1, 2, 3, 6, 7, 10 (docs part); clients Tasks 12, 13a, 13, 14, 15, 16.
- **D2** (connect this machine): core Tasks 4, 5, 11, 8, 9; clients Tasks 17, 18, 19, 20.
- **Order:** the device tasks start in wave 1 because they share no files with D1. D2 ships only
  after D1.
