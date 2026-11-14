# Agents: attribution

Agents can create git commits and open pull requests. Capybara asks the model to add an attribution
line to both, so someone reading a commit or a pull request can see that an agent made it and open
the conversation it came from. The kernel only **instructs the model**: it never rewrites git
history or edit a pull-request body.

## Two levels

- **Platform defaults** apply to every agent. They are set once for the deployment: in the startup
  config (`attribution.commit`, `attribution.pr`, `attribution.sessionUrl`; see
  [docs/config.md](../config.md)) or, when the config leaves a field unset, in **Admin → Settings →
  提交与 PR 署名**. A field set in the startup config is read-only there.

  | Field | Default |
  |---|---|
  | Commit trailer | `Co-Authored-By: Capybara <noreply@capybarahq.com>` |
  | Pull request line | `🤖 Generated with [Capybara](https://github.com/capybara-hq/core)` |
  | Conversation link | off; it needs `http.publicUrl` set and adds `<http.publicUrl>/chat/<conversation id>` to the pull request |

  An empty line turns that part off.

- **An agent's own setting** is on its page under **提交与 PR 署名**: **跟随平台** (the default) uses the
  platform defaults, **自定义** uses this agent's values, **关闭** adds nothing. A sub-agent follows its
  parent agent's setting where it inherits it; a plugin agent template uses the platform defaults.

The values are fixed at the start of each run and recorded in the conversation, so a later change
reaches the next run, not the one already in progress.
