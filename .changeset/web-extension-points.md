---
"@capybara-hq/plugin-sdk": minor
---

Add the `web-search@1` and `web-fetch@1` extension points (`WebSearchProvider`, `WebFetchProvider`, `WebProviderError`, `isPublicHostname`), `ExtensionPointInfo.selection`, and the `web_fetch` model call purpose. A `web-fetch@1` provider that fetches from inside the deployment must refuse non-public addresses after DNS resolution (documented on `WebFetchProvider`).
