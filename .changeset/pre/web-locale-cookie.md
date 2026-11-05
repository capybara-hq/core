---
"@capybara-hq/web": patch
---

The UI language leaves the URL, language and theme are one click away, and the tab has an icon.

- **Language in a cookie:** page URLs no longer start with `/zh` or `/en`. The language comes from
  the `NEXT_LOCALE` cookie, else the browser's Accept-Language, else Chinese, so the server renders
  the right language at once. An old link such as `/zh/agents` redirects (308) to `/agents` and keeps
  its language in the cookie. The web image's healthcheck now requests `/login`.
- **Language and theme controls:** the sidebar's foot shows a language dropdown and a light / dark
  theme radio above the account (in the narrow rail they lead the account menu); the login, setup,
  invitation and binding pages show the same controls under their card.
- **Tab icon:** the capybara mark, in each theme's accent color.
