---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Connectors carry a git source: the create body accepts `git` (the SDK's `GitSourceSchema`), a
template's `git` is stored at install and on template updates (`connectors.git_hosts`), and an org
admin can turn on `useForGit` for an org-credential connector. `GitSources.sourcesFor` picks one
connector per git host for an actor (own personal credential, org connectors only with
`useForGit`, the org's `gitGateway.hostSources` pick, else OAuth, else the oldest; nothing for
anonymous guests). `Credentials.gitAuthorization` builds the Basic value inside `Credentials`;
`GitIdentities` reads the GitHub name and noreply address once (cached 24 h). An invalid stored
`gitGateway` org setting now reads as off.
