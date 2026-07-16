# ATLAS Reliability and Winner-Rest Implementation Plan

1. Add failing persistence and rotation tests; make rotation and balances atomic, preserve corrupt evidence, add durable entry intent, and restore it as a startup lease.
2. Add failing route/control tests; prevent unsafe mode/disconnect/reset/account changes while exposure or execution is pending.
3. Add real-Chrome regression fixtures for hidden account text, stale quantity markers, and delayed confirmations; scope browser selectors and make confirmation fail closed.
4. Return account-scoped entry equity from the worker and use exact account-scoped settlement on close.
5. Make monitor cycles isolate failures, reconnect closed contexts, surface keyed incidents, and keep webhook fallback correlated to the exact trade.
6. Reject unsupported limit alerts, validate close identity, and strengthen idempotency across restart with a persisted signal ledger.
7. Implement eval-only manual/automatic winner rest, correct next selection, 6 PM ET rollover re-arming, and dashboard badge/buttons.
8. Add compact credential webhook URLs and remove unsafe reset UX.
9. Run TypeScript, complete real-Chrome suite, repeated concurrency stress, repeated browser stress, and latency measurements.
10. Copy the verified build to the v3 live directory in Practice/Paused mode, verify localhost health/UI, commit, and push the branch.
