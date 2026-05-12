# Findings: Aptny Growth Onboarding Dogfood

Run date: 2026-05-11

Primary run: `preflight_20260511T210414Z`

Session log:
`/home/luciano/.codex/sessions/2026/05/11/rollout-2026-05-11T16-59-50-019e18d6-cb13-7be2-b8a9-f4a258d327ae.jsonl`

Target repo:
`/home/luciano/aptny`

Growth repo reviewed from:
`/home/luciano/growth`

Portless artifact requested:
`/tmp/portless`

Portless artifact found and reviewed instead:
`/tmp/vercel-labs/portless` at commit `d564c2c0974a9ad2a5aad6af23068d3f721aff73`

## Summary

The agent used Growth well as a control plane, but the produced Aptny experiment is not merge-ready. The procedural usage was solid: it initialized Growth, followed `llm-context`, created a structured experiment, added connector state, wired app events, ran app checks, and prepared a synthetic preflight packet run.

The failure is semantic rather than procedural. Growth allowed the agent to reach `ready_for_preflight: true` even though the prepared browser-agent path is fragile: synthetic query params are attached to the root URL, the experiment runs on an auth-gated `/onboarding` route, query param persistence only happens after the onboarding component loads, and local connector validation passed without any actual local event evidence.

Grade for the agent's Growth usage: **B- / 7 out of 10**.

## What The Agent Did

The agent initialized Growth in `/home/luciano/aptny`, created the experiment `onboarding-profile-completion`, and prepared the run `preflight_20260511T210414Z`.

Important run artifacts:

- Experiment spec: `/home/luciano/aptny/.growth/experiments/onboarding-profile-completion.json`
- Growth state: `/home/luciano/aptny/.growth/state.json`
- Local connector: `/home/luciano/aptny/.growth/connectors/local.json`
- Preflight run: `/home/luciano/aptny/.growth/runs/preflight_20260511T210414Z/run.json`
- Agent URL packet: `/home/luciano/aptny/.growth/runs/preflight_20260511T210414Z/agent-packets/agent-1.url.txt`
- Agent policy packet: `/home/luciano/aptny/.growth/runs/preflight_20260511T210414Z/agent-packets/agent-1.policy.json`

The Aptny working tree after the run:

```text
 M .gitignore
 M AGENTS.md
 M CLAUDE.md
 M app/onboarding/page.tsx
 M components/onboarding/SinglePageProfile.tsx
 M lib/search-profile-actions.ts
?? .growth/
?? lib/onboarding-experiment-client.ts
?? lib/onboarding-experiment.ts
```

The app implementation added:

- `userId` passed from `/onboarding` to the client form: `/home/luciano/aptny/app/onboarding/page.tsx`
- Client-side assignment and event context: `/home/luciano/aptny/lib/onboarding-experiment-client.ts`
- Shared experiment constants and context validation: `/home/luciano/aptny/lib/onboarding-experiment.ts`
- `onboarding_started` and `onboarding_error` tracking in the form: `/home/luciano/aptny/components/onboarding/SinglePageProfile.tsx`
- `onboarding_completed` enrichment on first profile save: `/home/luciano/aptny/lib/search-profile-actions.ts`

The agent reported these checks as passing:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `growth connector validate local --json`
- `growth instrumentation verify onboarding-profile-completion --json`
- `growth preflight prepare onboarding-profile-completion --agents 4 --browser --app-url http://localhost:3000 --json`

The session log confirms that Growth verification returned `actual_events_verified: false` while still returning `ready_for_preflight: true`.

## Issue 1: Root URL Preflight Does Not Match Route Target

The experiment targets authenticated renters visiting `/onboarding`, and its scenarios instruct agents to open `/onboarding` with prepared query params. The prepared packet URL is root:

```text
http://localhost:3000/?agent_generated=true&agent_run_id=preflight_20260511T210414Z_agent_1&experiment_id=onboarding-profile-completion&variant=control
```

That means the synthetic identity is attached to `/`, not directly to `/onboarding`.

This matters because `/onboarding` is auth-gated. The page redirects unauthenticated users to `/login`. If an agent starts at `/`, signs in, and later reaches `/onboarding`, the original synthetic params can easily be gone before the onboarding hook reads them.

Growth should make this harder to miss. When an experiment has `targeting.domains: ["/onboarding"]`, `preflight prepare` should either:

- build packet URLs against that route when `--app-url` has no path, or
- warn that the app URL path `/` does not match the targeted route `/onboarding`, or
- require an explicit `--start-path /onboarding` for browser preflights.

## Issue 2: Synthetic Query Params Are Persisted Too Late

The app persists `agent_generated`, `agent_run_id`, `experiment_id`, and `variant` in `useOnboardingProfileExperiment`, which only runs inside `SinglePageProfile`.

That is too late for a flow where the preflight starts outside the instrumented component. Synthetic params need to be captured at the first app entry point, before login redirects, client navigation, or route transitions can drop them.

The better module shape is a small app-level synthetic traffic module:

- one interface that reads URL params once and persists them to `sessionStorage`
- one interface that returns the current synthetic context for event payloads
- one adapter for client events
- one adapter for server/action handoff

That would give Growth better locality: every event caller would stop knowing about URL query parsing, storage keys, and forced variant semantics.

## Issue 3: Local Connector Passed Without Local Evidence

The local connector points at `tmp/events.jsonl`, but the Aptny app does not write local JSONL events there.

Connector validation only validated the connector config. Instrumentation verification then reported:

```json
{
  "connector_coverage_ok": true,
  "static_contract_ok": true,
  "actual_events_verified": false,
  "ready_for_preflight": true
}
```

This is technically honest but product-confusing. `ready_for_preflight` reads stronger than the evidence supports.

Suggested Growth change:

- rename this to `static_ready_for_preflight`, or
- keep `ready_for_preflight` but include a warning that no actual event evidence was observed, or
- reserve readiness language for a completed local dry-run or provider-backed synthetic pull.

## Issue 4: Guardrail Coverage And Scenario Coverage Are Confused

The experiment defines:

- primary: `onboarding_completed / onboarding_started`
- guardrail: `onboarding_error / onboarding_started`

The happy-path preflight scenarios only expect:

- `onboarding_started`
- `onboarding_completed`

But the generated policy's full expected event list also includes `onboarding_error`.

This follows the current Growth context definition: preflight coverage comes from every metric event, denominator event, and explicit instrumentation event. The dogfood run shows the rough edge. A successful happy-path onboarding run should not emit `onboarding_error`, but the audit trail still wants confidence that `onboarding_error` is observable.

Growth needs a clearer distinction between:

- events expected in this scenario
- events required somewhere in the run
- guardrail/error events that need a negative-path scenario or static observability proof

For this experiment, Growth should either generate an explicit validation-error scenario or mark `onboarding_error` as a guardrail observability check rather than a happy-path expected event.

## Issue 5: Assignment Should Probably Be Stable By User

The experiment is for authenticated renters, the onboarding page already has `session.user.id`, and completion is tracked server-side by user. The spec still uses:

```json
"stable_by": "anonymous_id"
```

The implementation hashes an anonymous browser-local ID. That can put the same authenticated user in different variants across devices or browsers.

For this product surface, `stable_by` should probably be `user_id`. Anonymous/session IDs are still useful for synthetic traffic and debugging, but the experiment assignment should match the authenticated measurement unit.

## Issue 6: Control Variant Drifted

The agent mostly preserved the control, but the control copy drifted from the original em dash version to an ASCII hyphen version:

```text
Pick neighborhoods you'd actually consider. Be picky - you can change this later.
```

This is minor, but it is the kind of accidental control mutation that becomes more likely when control and treatment are implemented in the same file with conditional copy.

## Variant Per Branch

This run supports the variant-per-branch idea.

Runtime `if (variant)` implementation is simple for tiny copy tests, but it couples control and treatment edits in the same module. That makes it easy to accidentally change control while implementing treatment. It also makes preflight less concrete: "variant" becomes a flag value instead of a reviewable code artifact.

The better model is:

- one experiment contract
- one branch or worktree per variant implementation
- variant metadata records branch, PR, and commit hash
- preflight packets get a URL for the concrete variant implementation
- analysis still keys events by one experiment id and canonical `variant_id`

This preserves the shared experiment identity while giving code review, rollback, and synthetic preflight a concrete artifact.

## Portless Assessment

Portless looks useful for exactly this class of problem.

The requested path `/tmp/portless` did not exist. I reviewed `/tmp/vercel-labs/portless`, whose README describes stable named local URLs, automatic free-port assignment, HTTPS, worktree-aware hostnames, and injected `PORTLESS_URL`.

Relevant Portless properties:

- `portless run next dev` exposes the app at a named URL such as `https://myapp.localhost`
- linked git worktrees get branch-prefixed URLs such as `https://fix-ui.myapp.localhost`
- child processes receive `PORTLESS_URL`
- routes are stored in Portless state and can be listed with `portless list`
- Tailscale/Funnel modes can expose local variants to remote browser agents when needed

That would help Growth in three ways.

First, it avoids hardcoded `http://localhost:3000`. Growth currently resolves Next apps to `http://localhost:3000` unless state or `--app-url` overrides it. Portless gives the running app a stable handle independent of the ephemeral port.

Second, it pairs naturally with variant-per-branch. If each variant runs in its own worktree, Portless already turns the branch into a unique hostname. Growth could prepare packets like:

```text
https://control.aptny.localhost/onboarding?...variant=control
https://guided-onboarding.aptny.localhost/onboarding?...variant=treatment
```

or use Portless's native worktree prefixing:

```text
https://onboarding-profile-completion-control.aptny.localhost
https://onboarding-profile-completion-treatment.aptny.localhost
```

Third, hostnames isolate browser storage better than ports on `localhost`. That matters for synthetic assignment and auth. Different variants can have separate cookies and `localStorage`, which reduces cross-run contamination.

Portless does not solve the whole problem. Growth would still need:

- route-aware packet URLs, especially `/onboarding`
- app-level synthetic param persistence before auth/navigation
- event evidence, not just connector config validation
- clearer guardrail scenario semantics
- a way to represent variant code refs in the experiment contract

The best interface would be a Growth adapter over Portless, not a direct dependency scattered through preflight code:

```text
growth preflight prepare <experiment>
  -> resolve variant URLs from explicit app-url, Growth local state, PORTLESS_URL, or Portless routes
  -> append route path and synthetic query params
  -> write packet URLs per concrete variant URL
```

Architecturally, this is a good module seam. Growth owns experiment state and preflight packets. Portless owns local route resolution and stable URLs. The interface between them can stay small: "given a repo/worktree/variant, return the browser URL to exercise."

## Recommended Follow-Ups

1. Add route-aware preflight URL construction: use experiment targeting domains or a new `--start-path`.
2. Add Portless-aware app URL resolution: prefer explicit `--app-url`, then `PORTLESS_URL`, then Growth local state, then framework defaults.
3. Add variant implementation metadata to the experiment contract: branch, worktree path, PR URL, commit hash, and app URL.
4. Change readiness language so static verification cannot look like completed synthetic evidence.
5. Split preflight coverage into scenario events, run-required events, and guardrail observability.
6. Update the Growth guidance so authenticated experiments default to `stable_by: user_id`.
7. Consider a small app-level synthetic traffic helper template so agents capture synthetic params before route/auth transitions.
