---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

The web loads client extensions through a client host: the workspace layout renders an import map
(with the request's CSP nonce and each entry's integrity), a preload per entry and the plugin
stylesheets; `ClientHost` imports the entries after hydration (10 s each), checks name, API version
and component slots, keeps the registry, feeds the plugins' client event listeners, applies the
crash budget (three errors switch a build off for the browser session), reports failures once per
document and turns client navigations between the workspace and the admin console into document
loads. `?safe-ui=1` loads no client code and shows the safe-mode banner; the error pages offer a
reload in safe mode. The host shims are generated at dev and build (`gen:client-host`) under
`/_capybara/client-host/<webBuild>/`, which the document CSP allows.
