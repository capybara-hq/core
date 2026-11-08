# Environments phase 1: live acceptance checklist

Run on a fresh deployment with the pinned sandbox plugins (`sandbox-docker` 0.1.0-rc.4, images
`ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.4`).

## Docker

- [ ] With only a Docker endpoint configured, the sandbox and egress images are pulled (no local build).
- [ ] Two conversations share files in 个人环境.
- [ ] A new environment from 新建环境 is picked before the model.
- [ ] Suspension after 10 idle minutes keeps files.
- [ ] Removing a volume by hand shows 文件已丢失, and 重建文件 works.
- [ ] `/env` in a Lark direct message.

## E2B (needs CAPYBARA_TEST_E2B_API_KEY; not in ~/.capybara-test.env today)

- [ ] With only an API key, the template is built from the published image on first use.
- [ ] Alias and build responses carry `public: false` (the plugin's fail-closed check).
- [ ] `POST /v3/templates` on an alias this team owns does not return 409.
- [ ] Pause with `{memory: false}` ends processes and keeps files.
- [ ] `autoPauseMemory: false` on timeout.
- [ ] A not-ready alias returns 404 on create.
- [ ] `DELETE` removes the sandbox from the metadata list.
- [ ] `PUT /sandboxes/{id}/network` on a paused sandbox: record the result in the e2b README.
- [ ] 30-day retention of a paused sandbox (ongoing; record in the e2b README).
