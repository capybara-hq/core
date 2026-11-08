---
"@capybara-hq/web": minor
---

Themed first paint: the workspace and sign-in layouts read the viewer's resolved theme (the org's
themes, or the platform default before sign-in), link its stylesheet in the streamed `<head>`, pass
its logo and wordmark to the design system and use its favicon; the account row's scheme toggle is
hidden under a single-scheme theme.
Switching themes without a reload leaves only the current theme's stylesheet enabled.
