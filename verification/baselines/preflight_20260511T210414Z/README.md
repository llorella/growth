# Baseline: `preflight_20260511T210414Z`

Date: 2026-05-11

This baseline records the first Aptny onboarding dogfood run that motivated the
new verification harness.

Session log:

```text
/home/luciano/.codex/sessions/2026/05/11/rollout-2026-05-11T16-59-50-019e18d6-cb13-7be2-b8a9-f4a258d327ae.jsonl
```

Aptny stash:

```text
message: On master: growth-dogfood-preflight_20260511T210414Z
stash commit: 2e1d416bd431bfbae2e32d07385e8becc2465703
```

The active Aptny `.growth` directory was removed after stashing so future
verification runs start from a clean target repo. This baseline should be used
as evidence, not as reusable target state.

See also:

- `findings.md`
- `plan.md`
