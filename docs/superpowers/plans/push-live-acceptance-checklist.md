# Push notifications: live acceptance checklist

Run by the maintainer on real devices once the kernel, a push plugin and the mobile clients are deployed.

- [ ] Waiting for you (approval, question, connect request) reaches an iPhone through `push-apns`.
- [ ] Agent replies (run finished and failed) reach an iPhone.
- [ ] Task status (background task, sub-agent finished) reaches an iPhone.
- [ ] Scheduled tasks (ran and failed) reach an iPhone.
- [ ] Waiting for you reaches an Android phone with Play services through `push-fcm`.
- [ ] Agent replies, task status and scheduled tasks reach an Android phone with Play services.
- [ ] Waiting for you reaches an Android phone without Play services through `push-jpush`.
- [ ] Agent replies, task status and scheduled tasks reach an Android phone without Play services.
- [ ] A push for the conversation on screen is not shown in the foreground; any other shows as a banner.
- [ ] Tapping a push opens the right profile and the right org (an org other than the current one).
- [ ] With `push.previews: off` no conversation title appears; with `titles` it does, and never message text.
- [ ] Signing out and removing a profile stop pushes to that device.
- [ ] A wrong APNs key raises the platform notice `push_auth_failed` and the extension-deployment check says failing.
