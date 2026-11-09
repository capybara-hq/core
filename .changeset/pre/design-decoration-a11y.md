---
"@capybara-hq/design": patch
---

`DecorationLayer` no longer puts `aria-hidden` on the whole layer: it hides each decoration element
from assistive tech and leaves interactive ones (marked `data-cap-interactive`, or focusable) and
their ancestors exposed, keeping up with the plugins' later DOM changes, so an interactive element
never sits under `aria-hidden`.
