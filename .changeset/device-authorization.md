---
"@capybara-hq/kernel": patch
---

Device sign-in for connected machines: `POST /api/v1/device/authorize` and `/token` (RFC 8628
shape, public), the confirmation routes `GET /api/v1/device/pending/:userCode`,
`POST /api/v1/device/confirm` and `/deny` (web session), per-machine `cap_dev_` credentials
accepted only by the device connection, `DELETE /api/v1/orgs/:orgId/environments/:id/machine`,
and deleting a device environment revokes its machine.
