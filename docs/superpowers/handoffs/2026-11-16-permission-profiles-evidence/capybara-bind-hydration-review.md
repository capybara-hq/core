# Independent bind hydration review

Spec compliance: Approved.

Code quality: Approved.

Actionable findings: None.

Reviewed the complete implementation report, exact four-file diff and manifest against base `62d1deea7c4406539fb8aaaaa2fcb7a8483a8227`. Independently confirmed all four current source hashes match the manifest and the patch SHA-256 is `149258572604b7163752354fde97afbec7dd910af4774855264ecbd6b738de9c`. Read the applicable web instructions, full writing-web-ui skill, installed Next server/client hydration guidance, full BindView, actual design Button, mutation helper, regression tests and retained RED/GREEN logs.

The local `useSyncExternalStore` server snapshot is false during SSR and initial hydration; its browser snapshot enables controls after hydration. The snapshots are stable primitives and the subscription has no side effects. No mutation, automatic confirmation or consent bypass is introduced. The existing explicit Confirm handler remains the only confirmation trigger. Cancel remains a browser navigation and cannot fire before hydration or during confirmation.

The actual design Button combines `disabled || loading`, so Confirm's new readiness prop preserves its existing pending disable behavior. The pending-response test exercises both disabled controls and a second user click while the first POST is unresolved. The change preserves query behavior, account invalidation, session-expiry handling, ownership checks and login/native POST behavior; no kernel, SDK, shared design API or private hook changes appear in the patch.

The SSR regression uses real `renderToString` output and `hydrateRoot`, checks native disabled properties before hydration, checks recoverable hydration errors, observes no automatic calls, then performs an actual click and verifies one POST. Its cleanup resolves the held response and unmounts the manually created root. The retained RED log fails at the intended enabled SSR button assertion (1 failed, 8 passed); the final GREEN log records 9 passing tests.

The retained diagnostic e2e source and log demonstrate the original enabled button accepting a click with client scripts held, zero confirmation POSTs, and no success after release. The final e2e holds new-document Next scripts before login return, checks the visible identity and warning plus both disabled controls, releases in `finally`, and waits for in-flight route handlers through `unrouteAll({ behavior: "wait" })`. It then checks both controls enabled and zero automatic confirmation POSTs before clicking Confirm and observing exactly one POST and success. Existing real fake-IM reply and account-identities assertions remain. The final retained e2e log records 2 passing tests. The patch introduces no fixed sleeps, retries, raised deadlines or network-idle waits.

Review boundary: source and retained evidence only; I ran no tests, services or Git operations and changed no repository files. This approval is not a `pnpm verify` or Linux CI pass. Root owns the required repository gate and subsequent CI verification.
