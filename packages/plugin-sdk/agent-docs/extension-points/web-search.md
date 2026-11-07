# Extension point: web-search

<!-- generated:extension-point -->
- Name: `web-search` (a ref is `web-search@<major>`)
- Searches the web for the WebSearch tool; each org picks a default provider.
- Providers: several; each org chooses its default
- Enabled per org: yes
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: WebSearchProvider (`web.ts`)

Return ranked results for a query. Each org chooses its default provider; the kernel's WebSearch tool calls it.

See `extensions` for the rules every extension follows.
