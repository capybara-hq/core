# Extension point: web-fetch

<!-- generated:extension-point -->
- Name: `web-fetch` (a ref is `web-fetch@<major>`)
- Fetches and extracts web pages for the WebFetch tool; each org picks a default provider.
- Providers: several; each org chooses its default
- Enabled per org: yes
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: WebFetchProvider (`web.ts`)

Fetch a URL and return extracted page content. Admin-supplied URLs go through the kernel's network rules. Each org chooses its default provider.

See `extensions` for the rules every extension follows.
