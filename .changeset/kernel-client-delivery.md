---
"@capybara-hq/kernel": minor
---

The kernel delivers plugin client code. `GET /api/v1/client/<plugin>/<build>/<path>` serves the
entry, stylesheets and assets of a client build (`build` is the package sha256) to a signed-in
member, any role, of a live org where the extension is enabled, or to a super admin when the build
has a `platform.page` component; only while the build is the current package of a running
extension whose permission snapshot approves `permissions.client` and every `ui.component:<id>`.
Files are looked up by their exact manifest key (no decoding, no normalising, never a redirect);
anything else is 404 `client.not_found`. Responses are `private, max-age=31536000, immutable` with
`nosniff` and `Cross-Origin-Resource-Policy: same-origin`; SVG assets carry
`default-src 'none'; sandbox`. `GET /api/v1/orgs/:orgId/ui/client` (guest and up) lists the org's
client extensions with file URLs, integrity and the components the viewer's role may use;
`GET /api/v1/admin/ui/client?plugin=` (super admin) lists only `platform.page` components and no
stylesheets. Both are `no-store`. The deployment setting `clientExtensions: { enabled, disabled }`
(default `{ enabled: true, disabled: [] }`, written by `PUT /api/v1/admin/settings` and the
Platform operation `admin.update-settings`) stops all client code or that of the listed plugins.
