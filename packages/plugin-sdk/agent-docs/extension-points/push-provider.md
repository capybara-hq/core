# Authoring: extension point push-provider

<!-- generated:extension-point -->
- Name: `push-provider` (a ref is `push-provider@<major>`)
- Delivers push notifications to people's mobile apps through one channel (APNs, FCM, an aggregator).
- Providers: several
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: PushProvider (`push.ts`)

`send` answers one `PushResult` per registration (`checkPushResults`); a thrown `PushError` applies to every registration of the call. No retries inside: the kernel's queue retries `transient` and `rate_limited`, deletes an `unregistered` registration and tells the platform about `auth`. `apps()` is synchronous and derived from deployment config.

Map the channel-neutral `PushMessage` to the channel's payload: `title` and `body` as the alert, `path` and `origin` as data for the app, `threadId` as the grouping key (APNs `thread-id`), and `collapseId` as the channel's collapse key (APNs `apns-collapse-id`, FCM `collapse_key`): it is the same for every send of one event to one device, so a resend after a crash or a timeout replaces the notification. Never log a token.

See `extensions` for the rules every extension follows.
