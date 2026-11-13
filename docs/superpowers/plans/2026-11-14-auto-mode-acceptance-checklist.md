# Auto mode live acceptance checklist

Auto mode's automatic coverage runs in the kernel tests (`packages/kernel/test/sandbox/review-*.test.ts`,
`review-acceptance.test.ts`, `review-pipeline.test.ts`, `review.dual.test.ts`) and in CI. This is the
**manual** acceptance a person runs on real machines: the six scenarios that failed during acceptance
on 2026-11-12/13, the 本会话允许同类 grant, an IM run by the device owner waiting on a card, and the
mode switch on the machine. It needs a laptop, a cloud Docker device, a real model and (for step 7) a
connected IM channel, so no agent can run it.

Record every result in "Results" at the end: date, deployment build, OS, model, and the exact card
or output text you saw. Never paste a token, a code that is still valid, or a credential.

## 0. Prerequisites

- [ ] A deployment built from the auto-mode branch (`capybara migrate` has applied `0130` / `0131`),
      with at least one chat model configured for the org.
- [ ] `capybara-device` of the matching release installed on the macOS machine:
      `capybara-device --version`.
- [ ] The macOS machine signed in to the org with the user who owns the conversation
      (`capybara-device login`); the device page shows it 在线.
- [ ] A cloud device created in the same org (Docker sandbox provider enabled, an image with
      `git`, `curl` and `gh`).
- [ ] Auto mode allowed: platform `devices.autoMode: allowed` (default) and the org's
      **自动模式** switch on (default follows the platform).
- [ ] For step 7 only: an IM channel (Slack / Lark / Telegram) connected, the device owner's IM
      identity bound to their account, and the bot in a DM with them.

Record the baseline: `capybara-device mode` on the local machine (expect `auto` for a new login).

## 1. Clone a repository carrying protected files (local, auto)

Today's sandbox refused `.mcp.json`, `.claude/commands/`, `.vscode/`, `.idea/` anywhere, so
`capybara-hq/core` could not be checked out.

- [ ] On the **local macOS device** in auto mode, ask the agent: "Clone
      `https://github.com/capybara-hq/core` into the workspace and list it."
- [ ] Expected: the clone succeeds; the tool row records review `allow` (rule `allow.git`); the
      files `.mcp.json`, `.claude/commands/` exist in the workspace; no approval card.
- [ ] Repeat in **sandbox** mode (`capybara-device mode sandbox`): the file tools stay inside the
      workspace; a `Read /etc/passwd` is refused with the workspace path; the clone still lands
      under the workspace. No protected-file refusal.

## 2. A local server behind Docker's socket proxy (local, auto)

Acceptance had local servers off because a listener on `127.0.0.1:2375` was detected.

- [ ] With the Docker socket proxy running (`docker compose -f docker/compose.dev.yaml up -d`,
      then `docker -H tcp://127.0.0.1:2375 version` works from the terminal), ask the agent:
      "Run `curl http://127.0.0.1:2375/version`."
- [ ] Expected: review `allow` (rule `allow.network`), the command runs, the JSON version prints;
      no ask, no downgrade to `ask`.
- [ ] In **sandbox** mode the same command's review is still `allow`, but the device's network is
      the org's **白名单** (open it on the device page if the answer is a network refusal).

## 3. A background `git clone` (local and cloud)

- [ ] Ask the agent: "Clone `https://github.com/capybara-hq/core` in the background."
- [ ] Expected: the launch is reviewed **before** it starts (the launch row records `allow` /
      `allow.git`); the result says a background task started; `TaskOutput` shows the clone's
      output and the repository exists.
- [ ] Ask for a dangerous background launch (`rm -rf /`): expect a `deny` with the reason and
      **no** task started.
- [ ] Repeat on the cloud Docker device.

## 4. `gh pr create` on a local device

- [ ] On the local machine, make a branch change and ask the agent to open a PR
      (`gh pr create --title ... --body ...`).
- [ ] Expected: review `allow` (rule `allow.gh`); the command runs with the machine's own `gh`
      credential (the PR exists under the owner's GitHub account); no card.
- [ ] Record the PR URL and confirm it was created by the device owner's account.

## 5. `gh auth login` on a cloud Docker device

- [ ] On the cloud device, ask the agent: "Sign in to GitHub with `gh auth login --web`."
- [ ] Expected: the agent launches it in the background; when its output is read (`TaskOutput`)
      **one** device-code card appears under the call, with the URL `https://github.com/login/device`
      and an 8-character code; the timeline has exactly one card.
- [ ] Open the URL, enter the code; the login completes. The token stays in the container's device
      file system and appears in **no** conversation event (inspect the tool result: no token).
- [ ] `gh auth status` then succeeds on the cloud device.

## 6. A scheduled task hitting an `ask` command

- [ ] Create a scheduled task (run in a new conversation) that will call `sudo apt-get update`, and
      a second that writes `/etc/<name>` outside the workspace.
- [ ] Wait for a run (or trigger it).
- [ ] Expected: **no** approval card and **no** waiting; the tool result carries the deny reason
      ("This command needs approval … no one can approve it now; do it another way or leave it for
      the person."), the record says `deny` by `rule` (`ask.sudo` / `ask.outside-write`), and the run
      finishes rather than failing.
- [ ] Repeat on the cloud Docker device.

## 7. Session grant: 本会话允许同类

- [ ] In an attended conversation, trigger an ask (for example `git push --force origin main`).
- [ ] The card offers **允许一次 / 本会话允许同类 / 拒绝**. Choose **本会话允许同类**.
- [ ] Expected: the command runs; the record says `allow` by `person` with scope `session`.
- [ ] Ask for the same rule class again in the same conversation (another force push): no card;
      the record says `allow` by `rule` with the same rule.
- [ ] Ask for a **different** ask class (for example `sudo …`): a new card still appears. A `deny`
      rule is never turned into an allow by a grant.
- [ ] Repeat the same command in a **new** conversation: the card appears again (grants are per
      conversation).

## 8. IM run by the device owner waits on the card

- [ ] From the device owner's own IM DM to the bot, ask for a command that asks (for example a
      force push).
- [ ] Expected: this is an **attended** run, so it waits; a card appears **in the IM thread** with
      the command and the reason, and the run stays waiting. The web timeline shows the same card.
- [ ] Approve from the IM card: the run continues and the command runs once.
- [ ] Have **another** person trigger the same command through IM (or a scheduled task): it is
      unattended, so there is no card and the call is denied at once with the "no one can approve"
      text.

## 9. Mode switch on the machine

- [ ] On the local machine run `capybara-device mode`: it prints the current mode.
- [ ] Run `capybara-device mode sandbox`: it prints that commands now run in the sandbox and every
      command is still reviewed. The device page shows 沙箱.
- [ ] Run `capybara-device mode auto`: it asks for confirmation (or takes `--yes`) and then prints
      the auto-mode line. The device page shows 自动.
- [ ] On the web device page, switch a local device to 沙箱: it takes effect; switching back to
      自动 is refused (the page says to run `capybara-device mode auto` on the machine).
- [ ] For a **cloud** device, the page switches 自动 / 沙箱 and the network 开放（挡内网） / 白名单;
      the allowlist takes effect on the next command.
- [ ] With the platform's auto mode **off**, a local device that reports `auto` is refused
      (`device.auto_mode_not_allowed`); the machine can only run sandbox mode. When the OS sandbox
      is unavailable, `capybara-device mode sandbox` refuses rather than running unsandboxed.

## Results

| Step | Machine | Date | Result | Notes (card / output text, no secrets) |
|---|---|---|---|---|
| 1 clone | macOS local | | | |
| 1 clone (sandbox) | macOS local | | | |
| 2 local server | macOS local | | | |
| 2 local server (sandbox) | macOS local | | | |
| 3 background clone | macOS local | | | |
| 3 background clone | cloud Docker | | | |
| 4 `gh pr create` | macOS local | | | |
| 5 `gh auth login` | cloud Docker | | | |
| 6 scheduled `sudo` | cloud Docker | | | |
| 6 scheduled outside write | cloud Docker | | | |
| 7 本会话允许同类 | macOS local | | | |
| 8 IM card | macOS local | | | |
| 8 IM unattended | macOS local | | | |
| 9 mode switch | macOS local | | | |

Sign-off: name, date, deployment build. File an issue for every step that does not match; attach
the conversation id and the tool row, never a credential.
