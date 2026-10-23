---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
---

`capybara admin create` gains `--if-none` (skip with exit 0 when an active enterprise admin exists; the check and the insert run under the setup advisory lock, so concurrent runs create exactly one admin) and `--password-file <path>` (trailing newlines and a UTF-8 BOM are stripped; a missing file or multi-line content exits 1). Kernel: `SetupService.createEnterpriseAdminIfNone`; the `roles` config also accepts a comma-separated string (`CAPYBARA_ROLES=api,worker`). The CLI runs the compiled `dist` when its sources are absent, and new `docker/kernel.Dockerfile` builds the capybara-api / worker / gateway images.
