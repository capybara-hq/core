# Authoring: extension point config-source

<!-- generated:extension-point -->
- Name: `config-source` (a ref is `config-source@<major>`)
- Supplies deployment configuration from an external store such as Nacos.
- Providers: one at a time
- Enabled per org: no
- Brokered by the platform: no
<!-- /generated -->

Contract: (kernel-defined; no public SDK contract yet)

Deployment config precedence is env, then file or this source, then the database, then defaults. A source must never fail startup when its content is invalid.

See `extensions` for the rules every extension follows.
