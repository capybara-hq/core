---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
"@capybara-hq/web": minor
"@capybara-hq/design": minor
---

The product name people see follows `platform.name` (unset: Capybara) everywhere, not only in the
document title and the web app manifest (issue #452).

- Kernel: the IM bot's bind and web-hint phrases, the OAuth dynamic client registration name, the
  session user agent of desktop and mobile sign-ins, the `<name>:` prefix on git gateway messages,
  the platform overview the model reads, and the attribution defaults
  (`Co-Authored-By: <name> <noreply@capybarahq.com>`; the pull-request line links the upstream
  project only under the default name). The official marketplace is now named "Official
  marketplace", and messages that named the software in passing say "the platform".
- Web: every message that named the product takes the platform name from the public meta,
  including the sign-in, binding, invitation and app consent pages. Pages that cannot
  read the kernel (the root error page, a starting kernel) say the built-in name. `check:i18n`
  rejects the literal "Capybara" in web messages (`i18n-product-name`).
- Design: `Brand` gains `productName`, the `alt` of a theme's logo mark (else the wordmark, else
  "Logo"). The built-in `CAPYBARA` wordmark stays beside the pixel capybara whatever the name.
