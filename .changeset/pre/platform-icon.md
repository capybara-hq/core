---
"@capybara-hq/kernel": minor
---

Add the platform icon setting: super admins upload the app icon (512 × 512 PNG), its maskable
variant and an SVG favicon as JSON base64 (`/api/v1/admin/platform/icons*`, Platform operations
`admin.icons`, `admin.set-icon`, `admin.clear-icon`); the public
`GET /api/v1/platform/icon/:purpose?v=<sha256>` serves them for the manifest, favicons and native
clients. Migration 0164 adds `capybara.platform_icons`.
