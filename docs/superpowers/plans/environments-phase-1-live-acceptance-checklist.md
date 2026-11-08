# Devices phase 1: live acceptance checklist

Run on a fresh deployment with the pinned sandbox plugins (`sandbox-docker` 0.1.0-rc.5, images
`ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.5`).

## Docker

- [ ] With only a Docker endpoint configured, the sandbox and egress images are pulled (no local build).
- [ ] Two conversations share files in 个人设备.
- [ ] A new device from 新建设备 is picked before the model.
- [ ] Suspension after 10 idle minutes keeps files.
- [ ] Removing a volume by hand shows 文件已丢失, and 重建文件 works.
- [ ] `/device` in a Lark direct message.

## E2B

Plugin live test (`plugins/sandbox-e2b/test/live`, 13/13) run on e2b.dev on 2026-11-08 with 0.1.0-rc.4
plus capybara-hq/plugins#22, released as 0.1.0-rc.5. That run found that a `setsid` child survived a
timeout (real envd ends the stream when the command exits); #22 fixed it.

- [x] With only an API key, the template is built from the published image on first use
      (alias `capybara-sandbox-0-1-0-rc-4`).
- [x] Alias and build responses carry `public: false` (the build passed the plugin's fail-closed check).
- [x] `POST /v3/templates` on an alias this team owns does not return 409.
- [x] Pause with `{memory: false}` ends processes and keeps files.
- [ ] `autoPauseMemory: false` on timeout (not exercised: needs the sandbox's own timeout to run out).
- [ ] A not-ready alias returns 404 on create (not exercised live; covered by the fake E2B).
- [x] A killed sandbox is gone: `destroyFileSystem` then `create` throws `FileSystemGoneError`.
- [x] `PUT /sandboxes/{id}/network`: 204 on a running sandbox, 404 on a paused one (recorded in the
      e2b README; limits stay fixed at `createFileSystem`).
- [ ] 30-day retention of a paused sandbox (ongoing; record in the e2b README).
