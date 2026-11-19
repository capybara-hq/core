---
"@capybara-hq/web": minor
"@capybara-hq/capybara": patch
---

The web is an installable PWA: `/manifest.webmanifest` carries the deployment's name
(`platform.name`, "Capybara" unset) and platform icon (the app and maskable icons, else the
Capybara set the web ships), and the page title, the iOS web app title, the favicon and the
apple-touch-icon follow them. A signed-out browser may read the manifest and the two default PNG
icons (the sign-in proxy skips exactly those names). The super admin's deployment settings gain
应用图标 / App icon: upload the app icon, its maskable variant and the SVG favicon, or restore the
default; the `/api` proxy admits 2 MiB for the icon upload.
