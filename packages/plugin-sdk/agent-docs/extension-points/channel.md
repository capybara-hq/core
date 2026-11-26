# Authoring: extension point channel

<!-- generated:extension-point -->
- Name: `channel` (a ref is `channel@<major>`)
- Connects an instant-messaging platform (Slack, Lark): inbound events, replies and cards.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: no
<!-- /generated -->

Contract: Channel (`channel.ts`)

Normalize inbound events (messageId, threadId, tenantId, the bot mention stripped) and acknowledge only after the kernel's `onEvent` resolves. Long connections are held only by the gateway role. Replies use the card spec (`validateChannelCard`), including the `progress` card: on a channel with `features.edit` the kernel sends one per run and edits that message in place, so render it by capability and never send narration as separate messages. Files: implement the optional `sendFile` and declare `features.files` (the platform's bot limits); the kernel sends each conversation artifact as one message and falls back to a link line without it.

See `extensions` for the rules every extension follows.
