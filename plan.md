# Plan: Simplify And Deepen The Growth Control Plane

Date: 2026-05-12

Context:

- Dogfood run: `preflight_20260511T210414Z`
- Findings: `findings.md`
- Target problem: agents are being asked to stitch together shallow commands and skill instructions. That biases them toward local JSONL, hardcoded app URLs, and static readiness claims.

## Thesis

Growth should make commands deeper and skills thinner.

The outer coding agent should implement product changes against a clear experiment contract. It should not have to choose the evidence substrate, decide local vs provider validation, infer the correct app URL, interpret readiness ceilings, or manually reconcile scenario coverage with guardrail coverage.

Current Growth leaks too much implementation through its interface:

- choose `local` vs `posthog`
- add connector mappings
- understand JSONL shape
- know when `ready_for_preflight` is static only
- decide whether `complete-local`, `pull`, or `audit` is next
- remember that provider-backed preflight is different from local dry-run
- pass the right app URL
- preserve synthetic params
- interpret scenario vs guardrail coverage

That complexity belongs inside Growth modules, not in agent prompt text.

## Desired Control Plane

Move toward this smaller command surface:

```bash
growth status --json
growth experiment create ... --json
growth instrumentation plan <id> --json
growth instrumentation verify <id> --json
growth preflight plan <id> --json
growth preflight run <id> --json
growth preflight verify <run_id> --json
growth analyze <id> --json
```

The key change is `growth preflight plan`. It should produce one authoritative plan object that tells the agent what Growth knows, what is blocked, and what command is next.

Example provider-backed plan:

```json
{
  "preferred_evidence": "posthog",
  "why": "The app emits PostHog events and provider context is discoverable.",
  "fallbacks": ["local_jsonl"],
  "readiness_ceiling": "provider_preflight_passed",
  "blocking": ["posthog auth is not configured in Growth"],
  "next": "growth connector import stripe-projects --provider posthog --json"
}
```

Example local-only plan:

```json
{
  "preferred_evidence": "local_jsonl",
  "why": "No provider connector is configured or discoverable.",
  "fallbacks": [],
  "readiness_ceiling": "local_synthetic_ready",
  "blocking": [],
  "next": "growth preflight run onboarding-profile-completion --json"
}
```

## Module Priorities

### 1. Evidence Resolver

Own provider/local evidence selection.

Inputs:

- configured Growth connectors
- connector catalog
- safe env metadata
- Stripe Projects context when available
- app telemetry conventions found during inspection
- user-specified overrides

Output:

- preferred evidence source
- available sources
- blocked sources
- required setup commands
- readiness ceiling
- exact next command

Rules:

- Prefer provider-backed evidence when a real provider is configured or discoverable.
- Use local JSONL as a fast loop or fallback, not as the implicit default for provider-instrumented apps.
- Never let local JSONL imply provider ingestion or dashboard readiness.
- Do not ask the agent to infer provider credentials from raw `.env*`.

### 2. Preflight Plan

Own target URL, route, variants, scenarios, coverage, and evidence requirements.

Inputs:

- experiment spec
- targeting domains
- explicit `--app-url` or `--start-path`
- Growth local state
- `PORTLESS_URL`
- Portless route/worktree adapter
- variant implementation metadata when available
- evidence resolver output

Output:

- concrete packet URLs
- target route
- variant assignment strategy
- scenario-expected events
- run-required events
- guardrail observability events
- evidence source plan
- exact next command

This module should prevent the `/` vs `/onboarding` failure. If the experiment targets `/onboarding`, packet URLs should open `/onboarding` unless the user explicitly overrides that.

### 3. Readiness Model

Replace vague booleans with explicit states.

Proposed states:

- `static_ready`: spec, event names, connector coverage, and code hints look plausible.
- `local_synthetic_ready`: local app-emitted synthetic events passed audit.
- `provider_preflight_passed`: synthetic events were pulled through the configured provider and passed audit.
- `real_user_analysis_ready`: real-user evidence exists and is sufficient for analysis.

Implication:

- `ready_for_preflight` should be removed or renamed.
- Static checks should not sound like completed synthetic evidence.
- Local checks should not sound like provider-backed validation.
- Provider-backed synthetic checks should not sound like a ship decision.

### 4. Instrumentation Contract

Generate a contract the app must satisfy, independent of evidence source.

The contract should include:

- assignment stable key
- canonical event properties
- required events
- synthetic traffic propagation requirements
- idempotency requirements
- connector-specific envelope requirements only for the selected evidence source

For a PostHog app, Growth should generate PostHog-oriented verification first. Local JSONL should be presented as a fast-loop adapter only when the Evidence Resolver selects or recommends it.

### 5. Skill Diet

Generated skills should stop encoding a second control plane in Markdown.

The skill should mostly say:

```text
Run growth status --json.
Run the next command Growth gives you.
Do not choose evidence source, connector, app URL, or readiness semantics yourself unless Growth asks.
```

Keep skills focused on:

- safety policy
- do not read `.env*`
- use JSON output
- let Growth choose the next command
- product code remains the outer agent's responsibility

Remove or demote procedural recipes like:

- "Use local JSONL for the fast loop"
- "Add local connector before provider preflight"
- "Run complete-local after prepare"

Those should be command outputs, not static skill advice.

## Command Changes

### Add `growth preflight plan <id>`

Produces the authoritative preflight plan.

This should be the default command after instrumentation verification.

### Add or promote `growth preflight run <id>`

Runs the planned preflight path as far as Growth can safely go.

Behavior:

- if browser agents are not integrated, prepare packets and say exactly what remains manual
- if provider evidence is ready, pull provider-backed synthetic events after packet execution
- if only local evidence is available, run local validation with an explicit readiness ceiling
- if blocked, stop with setup commands

### Rename packet-only mode

Current `growth preflight prepare` is packet preparation. Keep it if useful, but make it explicit:

```bash
growth preflight prepare-packets <id> --json
```

It should not be the default recommended next step unless Growth cannot run more of the flow.

### Split verification commands

Current `instrumentation verify` mixes static and actual event checks.

Prefer:

```bash
growth instrumentation verify <id> --json
growth evidence verify <id> --json
growth preflight verify <run_id> --json
```

Or keep one command but emit explicit evidence tiers.

## Portless Integration

Portless should be an adapter under the Preflight Plan module, not a concept scattered through preflight code.

Interface:

```text
given repo/worktree/variant, return a reachable browser URL
```

Resolution order:

1. explicit `--app-url`
2. variant implementation URL
3. `PORTLESS_URL`
4. Portless route lookup
5. Growth local state
6. framework default

Benefits:

- avoids hardcoded `localhost:3000`
- gives each branch/worktree a stable URL
- supports variant-per-branch naturally
- isolates cookies and storage per variant hostname
- keeps Growth responsible for experiment semantics while Portless owns local route resolution

## Variant Implementation Model

Variant-per-branch should come after the preflight/evidence modules are deeper.

Add variant implementation metadata:

- variant id
- branch
- worktree path
- commit hash
- PR URL
- app URL
- implementation status

Growth should still analyze one experiment id with canonical `variant_id`; implementation metadata exists to make code review, preflight, rollback, and audit concrete.

## Migration Path

1. Add the readiness model and rename misleading outputs.
2. Add the Evidence Resolver and make `instrumentation verify` report an evidence plan.
3. Add `preflight plan` and make it the next command after instrumentation verification.
4. Change `preflight prepare` next steps so they no longer default to `complete-local`.
5. Thin generated skills to defer to Growth command output.
6. Add Portless app URL resolution.
7. Add route-aware packet URLs.
8. Add guardrail observability and negative-path scenario separation.
9. Add variant implementation metadata.

## Product Principle

The agent should not be choosing the experiment substrate.

Growth owns experiment state, evidence source selection, connector readiness, event windows, preflight coverage, and readiness semantics. The outer coding agent owns product interpretation and code changes against the contract Growth provides.
