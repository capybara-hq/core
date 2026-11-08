# Authoring: extension point channel

<!-- generated:extension-point -->
- Name: `channel` (a ref is `channel@<major>`)
- Connects an instant-messaging platform (Slack, Lark): inbound events, replies and cards.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: no
<!-- /generated -->

Contract: Channel (`channel.ts`)

Normalize inbound events (messageId, threadId, tenantId, the bot mention stripped) and acknowledge only after the kernel's `onEvent` resolves. Long connections are held only by the gateway role. Replies use the card spec (`validateChannelCard`).

See `extensions` for the rules every extension follows.
