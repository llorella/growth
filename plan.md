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
  "why": "A PostHog connector is configured and provider pull can be validated.",
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
- connector discovery results that were explicitly imported into Growth state
- user-specified overrides

Output:

- preferred evidence source
- available sources
- blocked sources
- required setup commands
- readiness ceiling
- exact next command

Rules:

- Prefer provider-backed evidence when a real provider is configured or explicitly imported.
- Use local JSONL as a fast loop or fallback, not as the implicit default for provider-instrumented apps.
- Never let local JSONL imply provider ingestion or dashboard readiness.
- Do not ask the agent to infer provider credentials from raw `.env*`.
- Do not infer provider use by grepping package files, source files, or provider strings during runtime planning.

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
6. declared project profile default

If none of those are available, Growth should return an explicit app URL blocker instead of guessing a localhost framework default.

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

## Connector Adapter Plan

Problem:

The current connector code has provider-specific knowledge in Growth core. PostHog behavior appears in connector CLI setup, preflight evidence planning, provider pull, connector catalog defaults, generated guidance, and tests. That worked for the first adapter, but it is already brittle. Adding Statsig, Amplitude, Segment, LaunchDarkly, or a warehouse connector would multiply conditional logic across the codebase.

Goal:

Make connector behavior plugin-shaped, while keeping the first implementation as built-in adapters. Growth core should speak generic connector concepts: capability status, setup plan, coverage, event mapping, and pull. Provider-specific details should live behind a connector adapter Interface.

Non-goal:

Do not build dynamic third-party plugin loading first. Runtime plugin loading introduces packaging, trust, versioning, sandboxing, and schema compatibility before we know the adapter Interface is stable. Start with an internal registry and built-in adapters.

### Target Interface

Create a connector adapter Interface with this shape:

```ts
interface ConnectorAdapter<TConfig = unknown> {
  kind: string;

  discover(root: string): Promise<ConnectorDiscovery[]>;
  defaultConfig(input: ConnectorDiscovery | AddConnectorOptions): TConfig;
  validateConfig(config: TConfig): ConnectorDiagnostic[];

  capabilityStatus(root: string, config: TConfig): Promise<ConnectorCapabilityStatus>;
  setupPlan(status: ConnectorCapabilityStatus): ConnectorSetupPlan;

  eventShapes(config: TConfig): ConnectorEventShape[];
  coverage(config: TConfig, experiment: Experiment): ConnectorCoverage;

  pull?(root: string, config: TConfig, window: EventWindow): Promise<unknown[]>;
  mapEvent(config: TConfig, raw: unknown): MappedEvent;
}
```

The important Interface contract is not the exact TypeScript spelling. The important contract is that Growth core only calls adapter methods and only understands generic concepts:

- `telemetry_write`
- `provider_pull`
- `local_synthetic`
- `setup_plan`
- `coverage`
- `pull`
- `map_event`

### Phase 1: Internal Registry

Add an internal connector registry:

```text
src/connectors/registry.ts
src/connectors/posthog/adapter.ts
src/connectors/local/adapter.ts
```

Rules:

- `registry.get(kind)` returns the adapter.
- CLI commands look up adapters by `kind` or source config.
- Preflight planning asks the adapter for capability status.
- Pull asks the adapter to pull and map provider events.
- Connector validation asks the adapter for config diagnostics and coverage.

Success criteria:

- No `if (connector.kind === 'posthog')` in `src/cli/preflight.ts`, `src/preflight/plan.ts`, or generic pull flow.
- PostHog-specific API paths live under `src/connectors/posthog/`.
- Local JSONL mapping lives under `src/connectors/local/`.
- Existing CLI JSON shape remains backward-compatible where reasonable.

### Phase 2: Move PostHog Behind The Adapter

Move these PostHog-specific modules behind the PostHog adapter:

- Stripe Projects / `.env` discovery
- default PostHog connector config
- PostHog capability status
- PostHog setup plan
- PostHog event pull
- PostHog raw event mapping
- PostHog event shape guidance

Keep Growth core responsible for:

- selecting preferred evidence
- interpreting capabilities
- readiness ceilings
- event windows
- preflight run creation
- analysis policy

This keeps locality: changing PostHog auth, host aliases, project-id behavior, or event API details should touch the PostHog adapter and its tests, not preflight planning or core pull.

### Phase 3: Move Local JSONL Behind The Adapter

Local JSONL should satisfy the same connector adapter Interface, even though it has no provider auth.

Its capabilities should be explicit:

- `local_synthetic.ready`
- `provider_pull` absent or unsupported
- `telemetry_write` not applicable

This prevents local JSONL from being a special case in evidence planning. It becomes another adapter with a lower readiness ceiling.

### Phase 4: Add A Second Provider Adapter

Add a non-PostHog provider before considering external plugins. Statsig is a good test because it will stress different assumptions:

- assignment may be provider-native
- event export/query APIs differ from PostHog
- config may involve server keys, client keys, environment tiers, or experiment ids
- event mapping may not be PostHog-style `event/properties`

Success criteria:

- Adding Statsig does not require new provider conditionals in preflight planning.
- Statsig capability blockers appear in the same generic shape as PostHog blockers.
- Verification can run against either PostHog or Statsig by changing connector config, not Growth core code.

### Phase 5: External Plugin Loading

Only after two provider adapters and local JSONL prove the Interface, consider external plugins.

External plugin requirements:

- manifest declares adapter name, kind, supported config schema version, and capabilities
- adapter package exports the connector adapter Interface
- Growth validates plugin output with schemas before trusting it
- plugin errors are converted to Growth diagnostics
- external plugins cannot read secrets except through Growth env helpers

This should be an extension of the registry, not a rewrite.

### Migration Order

1. Define generic connector adapter types and registry.
2. Wrap existing PostHog code in a PostHog adapter without changing behavior.
3. Wrap local JSONL in a local adapter.
4. Move `preflight/plan.ts` to adapter capability calls.
5. Move `lib/pull.ts` to adapter pull/map calls.
6. Move connector CLI auth/setup to adapter capability/setup plan calls.
7. Move connector catalog defaults into adapters or make the catalog registry-backed.
8. Add Statsig as the second provider adapter.
9. Revisit external plugin loading once the Interface has survived PostHog, local, and Statsig.

### Test Plan

Adapter-level tests:

- default config
- discovery
- capability status
- setup plan
- coverage
- raw event mapping
- pull URL/request construction where applicable

Core tests:

- preflight evidence planning uses adapter capabilities, not provider names
- provider-pull blocker shape is provider-neutral
- local JSONL keeps local readiness ceiling
- adding a fake adapter in tests exercises the registry without editing core conditionals

Verification tests:

- one Aptny run with PostHog configured but provider pull blocked
- one local JSONL synthetic loop
- one fake or Statsig adapter smoke showing the same control-plane flow

## Lean Architecture Plan

Problem:

Growth is becoming a sprawl of TypeScript files. The current tree splits behavior across `cli/`, `domain/`, `lib/`, and `preflight/`, but those folders do not cleanly match ownership. The result is shallow modules, large command files, provider-specific branching in core paths, and too many places an agent has to inspect before understanding the control plane.

Current pain points:

- `src/cli/instrumentation.ts`, `src/cli/preflight.ts`, and `src/cli/connectors.ts` are carrying product logic instead of just command registration.
- `src/lib/` mixes infrastructure with domain behavior, connector defaults, provider pull, generated skill content, and store mechanics.
- `src/domain/` is a vague bucket. Some files are experiment model code, some are evidence policy, some are analysis, and some are simulation.
- Provider-specific behavior is still too easy to add in core files.
- Analysis is distracting from the main goal. Growth does not need a rich analysis engine to prove the agent-native experiment loop.

Goal:

Make Growth lean around the actual near-term product:

```text
make an experiment -> instrument app -> verify contract -> run preflight -> collect evidence -> report readiness/blockers
```

Everything else should either move behind a deep Interface or be deferred.

### Target Source Layout

Move toward:

```text
src/
  cli/             # thin command registration only
  core/
    experiment/
    instrumentation/
    evidence/
    preflight/
  connectors/
    registry.ts
    types.ts
    posthog/
    local/
    statsig/
  lib/             # infrastructure only
```

`lib/` should be boring shared infrastructure:

- paths
- store
- env file helpers
- command envelope / runner
- project profile IO
- framework defaults keyed by explicit profile values
- app URL resolution
- low-level filesystem helpers

`lib/` should not own experiment policy, preflight readiness, connector semantics, provider setup, event coverage, or analysis.

### Delete The Vague `domain/` Bucket

`domain/` should go away, but not by dumping everything into `lib/`.

Move files by ownership:

- `domain/schema.ts`, `domain/types.ts`, `domain/builder.ts`, `domain/stats.ts` -> `core/experiment/`
- `domain/assignment.ts`, `domain/targeting.ts` -> `core/experiment/` unless preflight ownership becomes clearer during the move
- `domain/event-window.ts`, `domain/synthetic-traffic.ts` -> `core/evidence/`
- `domain/simulate.ts` -> either `core/evidence/` or defer/remove if simulation is not needed for the verification loop
- `domain/analysis-policy.ts`, `domain/analyze.ts` -> defer; keep isolated only if existing tests require it

Success criteria:

- no `src/domain/`
- imports tell the reader who owns behavior
- `lib/` remains infrastructure-only
- moving a policy changes one `core/*` module, not CLI and lib together

### Make CLI Thin

The CLI should parse args, call a core module, and wrap the result.

Target command files:

- `cli/preflight.ts` calls `core/preflight.plan/run/prepare/complete`
- `cli/instrumentation.ts` calls `core/instrumentation.plan/verify`
- `cli/connectors.ts` calls `connectors/registry` and connector setup plans
- `cli/experiments.ts` calls `core/experiment`

Rule of thumb:

- command registration can stay in `cli/`
- business behavior moves out
- no CLI file should remain a 600-800 line behavior module

### Defer Analysis

Analysis is the least important part of the current product loop.

Near-term rule:

- do not deepen analysis
- do not optimize analysis
- do not let analysis drive the architecture
- keep existing analysis commands working if cheap, but treat them as legacy/optional

The important readiness loop is provider-backed and synthetic evidence, not statistical ship decisions.

Analysis can be rebuilt later from clean evidence primitives:

- experiment definition
- assignments
- events
- segments
- event windows
- evidence source metadata

Until then, analysis code should not block the connector adapter work, preflight work, or CLI simplification.

### Adapter Work Fits Inside The Cleanup

The connector adapter plan should be part of the lean architecture work, not an additional layer of abstraction bolted onto the current sprawl.

Migration order:

1. Add `src/core/` and `src/connectors/` shells.
2. Define connector adapter types and registry.
3. Move PostHog capability/pull/discovery code behind `connectors/posthog`.
4. Move local JSONL behavior behind `connectors/local`.
5. Move preflight planning and packet/run behavior into `core/preflight`.
6. Move instrumentation planning and verification into `core/instrumentation`.
7. Move experiment schema/types/building into `core/experiment`.
8. Move event windows and synthetic traffic into `core/evidence`.
9. Delete `src/domain/`.
10. Leave analysis isolated and optional; revisit only after the preflight loop is clean.

### No-New-Sprawl Rule

Until the cleanup is complete:

- no new provider-specific conditionals in `cli/`, `core/preflight`, or generic pull paths
- no new domain behavior in `lib/`
- no new large CLI command implementations
- no new runtime source-text, dependency-name, route-prose, or provider-string heuristics
- no analysis feature work unless it is required to keep tests passing
- new behavior should land behind `core/*` or `connectors/*` Interfaces

## Heuristic Removal Plan

Problem:

Growth overcorrected for agent convenience. Because the command surface was shallow, we tried to keep agents moving by guessing missing facts from nearby code and text. That made demos smoother, but it taught Growth the wrong job: it started acting like a repo grep assistant instead of an explicit experiment control plane.

Actual heuristic debt in the current code:

- `src/lib/framework.ts`: `detectFramework` reads dependency names and sentinel files, including Next.js strings, then runtime commands treat that as project truth.
- `src/lib/code-hints.ts`: `scanSpaAgentContext` scans source files for router APIs, synthetic params, and session storage patterns.
- `src/preflight/plan.ts`: `detectPostHogConventions`, `fileContains`, `routeFromScenarios`, `firstRouteMention`, and `authenticatedTargetingEvidence` infer provider, route, and auth facts from strings.
- `src/cli/instrumentation.ts`: authenticated-targeting and client-navigation hints duplicate the same inference pattern inside a large CLI file.
- `src/cli/connectors.ts`: PostHog/Stripe Projects parsing currently lives in the CLI instead of a PostHog adapter import path.

Where we went wrong:

- We optimized for the first onboarding run instead of the control-plane boundary.
- We made missing state feel recoverable by guessing, when it should have been represented as `unknown`, `blocked`, or `configure this`.
- We mixed discovery, planning, and execution. Once discovery lived in runtime planning, string probes became policy.
- We had one provider and one target app, so PostHog and Next.js assumptions hardened into core behavior.
- Verification rewarded Growth command usage and successful continuation, but did not penalize brittle inference inside Growth itself.

Rule:

Growth core must not grep app source, dependency names, provider strings, or scenario prose to decide framework, provider, route, auth requirements, app URL, or evidence substrate.

Allowed inputs for runtime planning:

- experiment spec fields
- Growth project profile
- configured connector records
- connector adapter capability status
- explicit command flags
- explicit variant implementation metadata
- explicit Portless/runtime adapter output

Allowed discovery:

- adapter import or configure commands may inspect structured metadata when the user invokes them explicitly
- discovery output must be persisted as typed Growth config with source and confidence
- runtime planning may consume that persisted config, not rerun opportunistic scans

Disallowed runtime behavior:

- searching `package.json` or source files for `next`, `posthog`, router APIs, event names, or storage patterns
- deriving packet routes from scenario prose such as `/onboarding`
- inferring auth requirements from free-form segment names like logged-in, authenticated, `session.user`, or `user_id`
- choosing provider evidence because a provider string appeared in source text
- producing candidate implementation files from framework/file-presence guesses as if they were authoritative

### Project Profile Replacement

Add an explicit project profile as Growth-owned state:

```json
{
  "schema_version": 1,
  "framework": {
    "id": "nextjs-app-router",
    "source": "user"
  },
  "app_urls": {
    "default": "https://example.portless.local"
  },
  "routes": [
    {
      "id": "onboarding",
      "path": "/onboarding",
      "source": "experiment"
    }
  ],
  "auth_contexts": [
    {
      "id": "authenticated-user",
      "requires_session": true,
      "source": "user"
    }
  ]
}
```

The exact file shape can change. The architectural point is stable: project facts are declared or imported once, then consumed by plans.

Commands:

```bash
growth project show --json
growth project configure --framework nextjs-app-router --app-url <url> --json
growth project route add onboarding --path /onboarding --json
growth project auth-context add authenticated-user --requires-session --json
```

Connector imports should stay under connector adapters:

```bash
growth connector import stripe-projects --provider posthog --json
```

That command may inspect Stripe Projects metadata because the user asked for an import. The result should be a connector config and project profile update, not hidden runtime inference.

### Migration Order

1. Add project profile types, storage, and `growth project show/configure`.
2. Change `init`, `status`, `llm-context`, `instrumentation plan`, and `preflight plan` to read the project profile.
3. Replace missing profile facts with structured blockers and next configure commands.
4. Remove runtime `detectFramework` calls; keep only framework template helpers keyed by declared framework id.
5. Delete `scanSpaAgentContext`; make synthetic-context requirements part of the instrumentation contract instead of a source scan.
6. Delete `detectPostHogConventions` from preflight planning; require a configured connector or explicit connector import.
7. Delete `routeFromScenarios` and `firstRouteMention`; target route comes from explicit targeting domains, project routes, variant implementation URLs, or command flags.
8. Replace `authenticatedTargetingEvidence` regexes with explicit experiment/profile auth context fields.
9. Move Stripe Projects and PostHog parsing behind `connectors/posthog/adapter.ts`.
10. Add tests with fake repos containing `next` and `posthog` strings to prove runtime plans do not change unless the project profile or connector config changes.

## Migration Path

Implemented so far:

- `growth preflight plan <id>` now owns evidence preference, readiness ceiling, target route, packet URL, and next command.
- Packet URLs are route-aware: targeting domains with paths resolve to the packet start path. The current scenario-text route fallback is transitional debt covered by the heuristic removal plan.
- Provider-backed plans no longer default to local completion; they keep provider pull as the continuation after packet execution.
- PostHog connector defaults now keep app telemetry setup separate from provider pull setup: analytics key and host can be configured without making `POSTHOG_PROJECT_ID` a global connector requirement.
- `growth connector auth setup <source> --json` now reports provider-pull capability blockers, including the read-side `POSTHOG_PROJECT_ID` requirement, without implying app telemetry is broken.
- Provider-pull setup now makes manual blockers explicit with `resolution: manual_input_required`, `blocked`, `stop_reason`, `safe_commands`, and `retry_command`; preflight evidence blockers also mark `manual_input_required` and `capability: provider_pull`.
- `instrumentation verify` no longer reports `ready_for_preflight: true` when the resolved preflight plan is blocked.
- Generated skill guidance is thinner and now directs provider-pull blockers through Growth commands only.
- The app URL resolver now uses `PORTLESS_URL` before framework defaults, so packet URLs can follow Portless runtime context without the agent hardcoding localhost.
- Packet policies now use each packet scenario's expected event surface, while the preflight plan and audit still retain full run-required coverage and guardrail observability events.
- Instrumentation planning and verification now include assignment identity guidance; authenticated targeting with non-user assignment gets an `AUTHENTICATED_ASSIGNMENT_STABLE_BY` warning and a `user_id` recommendation.
- Instrumentation planning now flags authenticated routes as an `auth-gated-synthetic-context` pitfall, so agents capture synthetic query params before auth redirects or route guards can strip them.
- The instrumentation contract now includes `agent_traffic.synthetic_context`, a small structured Interface for app-level synthetic context capture, session storage, event propagation, forced-variant mapping, and reset rules.
- `instrumentation verify` now separates static-only readiness from emitted-event readiness with `ready_for_preflight_basis`, `static_ready_for_preflight`, `emitted_event_ready_for_preflight`, and a `STATIC_ONLY_PREFLIGHT_READINESS` warning.
- Instrumentation planning now includes `variant_integrity`, naming the control variant, treatment variants, and control-preservation requirements.
- Preflight planning now includes `browser_context`; authenticated targeting marks authenticated session requirements, emits `AUTHENTICATED_BROWSER_CONTEXT`, and writes that context into packet policy files.
- `growth preflight run <id>` now plans first, stops on blocked evidence setup, and prepares packets only for an unblocked path. `preflight prepare` remains available as packet-only mode.
- Variant implementation metadata can now be recorded on each variant with `growth experiment implementation set`. Preflight plans expose those concrete branch/worktree/commit/PR/app URL refs, and prepared packets use variant-specific `implementation.app_url` when present while still forcing canonical `variant_id`.
- The Aptny verification loop now distinguishes quota-only runner failures as `agent_unavailable` / `usage_limit` so they are not mistaken for Growth or target-app evidence.
- The verification loop now writes `artifacts/growth-usage-audit.json` for actual agent sessions. The audit grades Growth command coverage and flags control-plane escape hatches such as raw `.env*` reads, direct provider API probing, and direct reads of managed `.growth` state.
- Quota-only `agent_unavailable` runs intentionally skip the Growth usage audit, because there is no meaningful runner behavior to score.
- Verification `run.json` now promotes the usage audit summary into `growth_usage_*` fields, so the loop can identify excellent, poor, failed, and skipped Growth-usage evidence without opening every artifact first.
- The usage audit now separates preflight planning from run attempts, completion, and explicit blockers.
- The verification runner has automated coverage for both scored agent sessions and quota-only skipped sessions, using a disposable Git target instead of the Aptny repo.

Completion evidence:

- Post-quota Aptny run `verification/runs/aptny-onboarding-20260513T122553` completed with `growth_usage_grade: excellent`, `growth_usage_score: 100`, 68 Growth commands, zero anti-patterns, and no missing required Growth command categories.
- The runner used Growth Interfaces for provider connector import, provider readiness setup/check, instrumentation planning and verification, preflight planning, implementation metadata, and status checks.
- The runner stopped on Growth's explicit `POSTHOG_PROJECT_ID` manual-input blocker instead of reading raw env files or probing provider APIs directly.
- Follow-up correction: Growth now models that blocker as provider-pull readiness, not generic PostHog app telemetry readiness.

## Product Principle

The agent should not be choosing the experiment substrate.

Growth owns experiment state, evidence source selection, connector readiness, event windows, preflight coverage, and readiness semantics. The outer coding agent owns product interpretation and code changes against the contract Growth provides.
