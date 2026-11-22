---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Pages outside the theme (#451): the kernel-starting frame, the root error pages and the root 404
draw the theme this browser last drew (the `cb-brand` cookie, else the platform default); app
icons and the manifest colours follow the platform default theme; the browser's theme colour
follows the scheme shown (design `useThemeColorMeta`).
