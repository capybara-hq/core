---
"@capybara-hq/device": patch
---

A restricted macOS command trusts what the system trusts: the sandbox lets it look up the per-user
`com.apple.TrustEvaluationAgent`, which Apple's LibreSSL (`/usr/bin/curl`, the Command Line Tools'
`python3`) asks when `/etc/ssl/cert.pem` lacks a chain's anchor. Sites anchored at newer roots
(example.com) no longer fail with "unable to get local issuer certificate". `trustd` stays closed.
