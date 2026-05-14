# Plan: Lean Growth Control Plane

Date: 2026-05-13

## Product Principle

The agent should not be choosing the experiment substrate.

Growth owns experiment state, evidence source selection, connector readiness, event windows, preflight coverage, and readiness semantics. The outer coding agent owns product interpretation and code changes against the contract Growth provides.

## Current Baseline

The first dogfood loop already proved and implemented the deeper command direction:

- `growth preflight plan <id>` owns evidence preference, readiness ceiling, target route, packet URL, blockers, and next command.
- `growth preflight run <id>` plans first and stops on blocked evidence setup before preparing packets.
- PostHog app telemetry setup is separated from provider-pull readiness.
- `growth connector auth setup <source> --json` reports manual provider-pull blockers without exposing secrets.
- Instrumentation verification distinguishes static contract readiness from emitted synthetic event evidence.
- Variant implementation metadata can record branch, worktree, commit, PR URL, app URL, and status.
- The verification harness audits whether agents stay inside Growth's control plane.
- Project profile state now stores framework, app URL, routes, and auth contexts. Agents can manage it through `growth project show/configure/route add/auth-context add`.
- Runtime `status`, `llm-context`, `instrumentation`, and `preflight` paths consume the stored project profile instead of redetecting framework facts from source during those commands.
- Preflight route planning no longer parses route strings out of scenario prose. Target routes come from path-valued experiment targeting or project profile routes, and the plan reports `target_route_source`.

Those are baseline capabilities, not the remaining plan. The remaining plan is cleanup and architecture: make the modules deep enough that Growth does not need provider-specific branches, runtime source scans, or large CLI files.

Latest verification evidence:

- `verification/runs/aptny-onboarding-20260513T180437`: score 100, grade `excellent`, 58 Growth commands, zero anti-patterns. The agent adopted `growth project configure/show` and stopped on the PostHog provider-pull project-id blocker.
- `verification/runs/aptny-onboarding-20260513T181933`: score 100, grade `excellent`, 64 Growth commands, zero anti-patterns. After scenario-route inference was removed, the agent used `growth project route add onboarding --path /onboarding --json` and `growth project auth-context add onboarding-auth --requires-session --json`; the final preflight route was explicit, not inferred from scenario prose.
- `verification/runs/aptny-onboarding-20260513T212147`: score 100, grade `excellent`, 62 Growth commands, zero anti-patterns. After connector import routing moved behind adapter import results, the agent exercised `growth connector import stripe-projects --json`, `growth connector auth check/setup posthog --json`, `growth connector validate posthog --json`, explicit project route/auth configuration, and stopped on the PostHog provider-pull project-id blocker.
- `verification/runs/aptny-onboarding-20260513T214016`: score 100, grade `excellent`, 56 Growth commands, zero anti-patterns. After framework id canonicalization, the agent still used `growth project configure --framework nextjs --app-url http://localhost:3000 --json`, and Growth persisted the canonical `nextjs-app-router`; the agent then configured `/onboarding`, added a session-required auth context, imported the PostHog connector through Stripe Projects, validated connector coverage, recorded implementation metadata, and stopped on `POSTHOG_PROJECT_ID`.
- `verification/runs/aptny-onboarding-20260513T215510`: score 100, grade `excellent`, 66 Growth commands, zero anti-patterns. After the Statsig adapter smoke landed, the agent continued to use explicit project profile commands, imported PostHog through the adapter import path, checked/setup provider auth through adapter-owned plans, recorded implementation metadata, and stopped preflight on the same PostHog provider-pull project-id blocker without any Statsig confusion.
- `verification/runs/aptny-onboarding-20260514T124146`: score 100, grade `excellent`, 58 Growth commands, zero anti-patterns. After the live Statsig provider pull, `src/domain/` deletion, and connector command behavior extraction, the agent again stayed inside Growth's control plane: explicit project profile configuration, route/auth-context setup, experiment creation, instrumentation plan/verify, PostHog import through Stripe Projects, connector auth check/setup, connector validation, and preflight planning. It stopped provider-backed preflight on the PostHog project-id blocker rather than guessing around it.
- `verification/runs/aptny-onboarding-20260514T130339`: score 100, grade `excellent`, 82 Growth commands, zero anti-patterns. After experiment command behavior moved into `src/core/experiment/commands.ts`, the agent used `growth experiment create/update/implementation set`, connector import/auth/setup/validate, instrumentation verify, and preflight plan through Growth. The artifact exposed a route-planning edge case: a host-only targeting domain could become `packet_app_url: http://localhost:3000/3000` before the agent corrected the spec.
- `verification/runs/aptny-onboarding-20260514T131802`: score 100, grade `excellent`, 72 Growth commands, zero anti-patterns. After tightening route extraction to ignore host-only domains, the agent again stayed inside Growth commands and the final verify/preflight evidence showed `packet_app_url: http://localhost:3000/onboarding` even after the spec used a non-route domain label. Provider-backed preflight remained correctly blocked on `posthog-provider-pull-project-id`.
- Runtime PostHog convention discovery has been removed from preflight planning. A fake repo with `posthog-js` in `package.json` now gets `preferred_evidence: "unconfigured"` until a connector is imported or added in Growth state.
- Authenticated browser-context planning and assignment identity guidance now use explicit project profile auth contexts instead of regexes over targeting segment prose.
- `growth init --framework` and `growth project configure --framework` now canonicalize common explicit framework aliases such as `nextjs` to supported framework ids and reject unsupported ids instead of silently falling back to generic instrumentation hints.
- Preflight evidence planning now asks an internal connector adapter registry for capability and coverage status instead of branching on PostHog in `src/core/preflight/plan.ts`.
- Generic pull now asks connector adapters to fetch raw events. PostHog API reads live under `src/connectors/posthog/adapter.ts`, and local JSONL file reads live under `src/connectors/local/adapter.ts`; shared ingestion, dedupe, cursors, and pull artifacts stay in `src/lib/pull.ts`.
- Connector auth check/setup now delegates to adapter-owned auth plans. The PostHog adapter owns provider-pull setup requirements, Stripe Projects import suggestions, and Stripe Projects metadata parsing.
- Connector add/import config construction now goes through adapter `defaultConfig` methods. Connector add routing/persistence lives in `src/connectors/add.ts` and `src/connectors/persistence.ts`; connector import provider routing and file persistence go through adapter import results.
- Connector event mapping now goes through adapter `mapEvent` methods. The shared mapping implementation lives in `src/connectors/mapping.ts`; `src/lib/connectors.ts` only keeps compatibility re-exports.
- Preflight CLI continuations and audit provider-backed detection now use adapter metadata instead of source/kind checks. Preflight plan source summaries include `evidence_source`.
- Connector state/status required env, required scopes, and primary auth env now come from adapter metadata.
- Connector coverage now lives in `src/connectors/coverage.ts` and uses adapter `mappedEvents`; runtime commands import coverage from `src/connectors`, while `src/lib/connectors.ts` keeps only a compatibility re-export.
- Connector config validation now asks adapters for provider-specific diagnostics. `src/lib/connectors.ts` retains only generic connector-file and mapping-shape checks.
- Connector catalog defaults and PostHog capability helpers now live under connector-owned modules (`src/connectors/posthog/config.ts`, `src/connectors/posthog/capabilities.ts`, `src/connectors/local/config.ts`). `src/lib/connector-catalog.ts` is provider-neutral taxonomy/kind support.
- `growth init` no longer detects framework from package metadata or files. It records `unknown` unless `--framework` is explicit, and `doctor` reads the stored project profile instead of running framework detection. The old `detectFramework` source scanner has been deleted.
- A built-in Statsig adapter now exists under `src/connectors/statsig/`. It proves a second provider-backed adapter can supply default config, auth/setup blockers, provider-backed metadata, validation, mapping, coverage, and provider event pull without adding provider conditionals to preflight planning. The adapter uses the Statsig Console Events API, normalizes returned rows into Growth's Statsig event mapping shape, and filters them by Growth's pull window before shared ingestion.
- Generated skill/workflow guidance and `growth llm-context` no longer hardcode the PostHog pull/auth recipe. They direct agents to follow `growth preflight plan`, `_next.command`, and `connector_event_shapes` instead of choosing source-specific evidence from prompt text.
- Preflight planning, coverage, packet prompts, audit/report/markdown primitives, and preflight types now live under `src/core/preflight/`; packet/run creation lives under `src/core/preflight/packets.ts`; run persistence, report attachment/schema validation, pull, complete, complete-local, dry-run, and audit behavior live under `src/core/preflight/runs.ts`. `src/cli/preflight.ts` now owns command registration and delegates preflight behavior to core helpers. The legacy `src/preflight/` module cluster has been collapsed.
- Instrumentation command behavior now lives under `src/core/instrumentation/commands.ts`; contract, sample event, assignment identity guidance, pitfall, connector event-shape, and readiness-model helpers live under `src/core/instrumentation/contracts.ts`; endpoint checks, emitted-event JSONL verification, instrumentation run persistence, and taxonomy reads live under `src/core/instrumentation/verify.ts`. `src/cli/instrumentation.ts` is thin command registration.
- Experiment model/schema/building/statistics/assignment/targeting now live under `src/core/experiment/`; event-window, synthetic-traffic, and simulation live under `src/core/evidence/`; analysis lives under `src/core/analysis/`. The old `src/domain/` code bucket has no remaining files.
- Experiment command behavior now lives under `src/core/experiment/commands.ts`. `src/cli/experiments.ts` is command registration and delegates create/update/list/show/start/stop/archive and variant implementation metadata updates.
- Validation command behavior now lives under `src/core/validation/commands.ts`. `src/cli/validate.ts` is command registration plus initialization gating.
- Analysis command behavior now lives under `src/core/analysis/commands.ts`, keeping analysis as an isolated optional layer outside CLI registration.
- Simulation command behavior now lives under `src/core/evidence/commands.ts`, including destructive clear confirmation and next-step shaping.
- Preflight route extraction now treats only slash-prefixed paths and `http(s)` URLs with non-root paths as explicit target routes. Host-only labels such as `localhost:3000` or product/domain labels fall through to configured project profile routes instead of becoming bogus packet paths.
- `growth experiment update` now accepts `--from-file <path>` as well as inline `--from-json`, so agents do not need to shell large JSON specs through process args when refining an experiment after implementation details settle.
- Local verification after the connector adapter, auth-plan, default-config, add/import-routing, event-mapping, preflight provider-detection, env-metadata, coverage, validation, framework-detection cleanup, framework-id canonicalization, connector-owned defaults/capabilities, prompt-surface cleanup, deleted framework scanner, preflight command behavior extraction, preflight planning move, preflight coverage/types and packet prompt move, preflight audit/report/markdown move, instrumentation contract helper extraction, instrumentation verification IO extraction, instrumentation command behavior extraction, Statsig adapter smoke, live Statsig provider-pull implementation, core evidence primitive move, domain bucket deletion, connector command behavior extraction, experiment command behavior extraction, validation command behavior extraction, analysis command behavior extraction, simulation command behavior extraction, host-only targeting route guard, and experiment update file source: `npm run build` passes, focused preflight/experiment/validation/analysis/simulation tests pass, `npm test` passes 78/78, and `git diff --check` is clean.
- `verification/runs/aptny-onboarding-20260513T183426`, `verification/runs/aptny-onboarding-20260513T185206`, `verification/runs/aptny-onboarding-20260513T185529`, `verification/runs/aptny-onboarding-20260513T192629`, `verification/runs/aptny-onboarding-20260513T193230`, `verification/runs/aptny-onboarding-20260513T193854`, `verification/runs/aptny-onboarding-20260513T194103`, `verification/runs/aptny-onboarding-20260513T194317`, `verification/runs/aptny-onboarding-20260513T194635`, `verification/runs/aptny-onboarding-20260513T194935`, `verification/runs/aptny-onboarding-20260513T195439`, `verification/runs/aptny-onboarding-20260513T221341`, `verification/runs/aptny-onboarding-20260513T221843`, `verification/runs/aptny-onboarding-20260513T230801`, `verification/runs/aptny-onboarding-20260513T230954`, `verification/runs/aptny-onboarding-20260513T231428`, `verification/runs/aptny-onboarding-20260513T231839`, `verification/runs/aptny-onboarding-20260513T232128`, `verification/runs/aptny-onboarding-20260513T232352`, `verification/runs/aptny-onboarding-20260513T235136`, `verification/runs/aptny-onboarding-20260513T235412`, `verification/runs/aptny-onboarding-20260513T235852`, `verification/runs/aptny-onboarding-20260514T000159`, `verification/runs/aptny-onboarding-20260514T001342`, `verification/runs/aptny-onboarding-20260514T001957`, `verification/runs/aptny-onboarding-20260514T002302`, `verification/runs/aptny-onboarding-20260514T002848`, `verification/runs/aptny-onboarding-20260514T133423`, `verification/runs/aptny-onboarding-20260514T133705`, and `verification/runs/aptny-onboarding-20260514T135558` attempted real-agent verification after the PostHog-discovery/auth-context/source-scan and adapter-registry changes but hit Codex `usage_limit`, so they are classified as `agent_unavailable` and do not count as behavior evidence. The 22:13, 22:18, 23:08, 23:09, 23:14, 23:18, 23:21, 23:23, 23:51, 23:54, 23:58, 00:01, 00:13, 00:19, 00:23, and 00:28 attempts were after the connector persistence, connector-owned defaults/capabilities, prompt-surface cleanup, framework-scanner deletion, preflight packet/run core extraction, preflight completion/audit core extraction, preflight report-attachment core extraction, preflight planning module move, preflight coverage/types/packet prompt move, full preflight module collapse, instrumentation contract helper extraction, instrumentation verification IO extraction, instrumentation command behavior extraction, live Statsig provider-pull implementation, core evidence primitive move, and domain bucket deletion slices respectively; the 13:34 attempt was after adding `experiment update --from-file`, the 13:37 attempt was after validation command extraction, and the 13:55 attempt was after analysis/simulation command extraction. They are superseded by the scored `verification/runs/aptny-onboarding-20260514T131802` run after the route guard, except for the newest `--from-file`, validation-command, and analysis/simulation-command interfaces which are locally verified but not yet scored by Aptny.

## Implementation Priorities

1. Remove runtime heuristics by adding a project profile and making unknown project facts explicit blockers.
2. Move provider behavior behind connector adapters, starting with PostHog and local JSONL.
3. Move product logic out of large CLI files into `core/*` modules with clear Interfaces.
4. Delete the vague `domain/` bucket by moving files into owned `core/*` modules.
5. Keep analysis isolated and optional until the preflight/evidence loop is clean.
6. Keep verification focused on real agent runs against Aptny and small fake-repo tests for architecture regressions.

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

- No `if (connector.kind === 'posthog')` in `src/cli/preflight.ts`, `src/core/preflight/plan.ts`, or generic pull flow.
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

Current status:

- Done: adapter types/registry, PostHog and local adapters, preflight capability/coverage planning through adapters, raw event fetching through adapters, connector auth check/setup through adapters, connector default config construction through adapters, connector add routing/persistence through connector helpers, connector import provider routing and persistence through adapter import results, event mapping through adapter `mapEvent`, preflight provider-backed decisions through adapter metadata, preflight planning, coverage, packet helpers, audit/report helpers, and command behavior extracted to `core/preflight`, instrumentation command behavior extracted to `core/instrumentation`, connector command behavior extracted to `src/connectors/commands.ts`, experiment command behavior extracted to `src/core/experiment/commands.ts`, validation command behavior extracted to `src/core/validation/commands.ts`, analysis command behavior extracted to `src/core/analysis/commands.ts`, simulation command behavior extracted to `src/core/evidence/commands.ts`, `growth experiment update --from-file`, runtime connector env/scope metadata through adapters, connector coverage through adapter `mappedEvents`, provider-specific connector validation through adapters, connector catalog defaults/capabilities moved to connector-owned modules, runtime framework detection removed from `init`/`doctor`, dormant framework scanner deleted, explicit framework ids canonicalized/validated, generated skill/llm-context prompt crutches removed, Statsig second-provider adapter with provider pull, host-only targeting route guard, deletion of the vague `src/domain/` code bucket, and fresh scored Aptny runs after the latest cleanup.
- Not done: remaining architecture cleanup is mostly slimming adjacent CLI files and keeping analysis isolated as optional legacy behavior.

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

Actual heuristic debt in the current code after the latest loop:

- `src/cli/connectors.ts`: connector command behavior now lives in `src/connectors/commands.ts`; the CLI file is thin command registration.
- `src/cli/experiments.ts`: experiment command behavior now lives in `src/core/experiment/commands.ts`; the CLI file is thin command registration.
- `src/cli/validate.ts`: validation behavior now lives in `src/core/validation/commands.ts`; the CLI file is thin command registration.
- `src/cli/analyze.ts`: analysis behavior now lives in `src/core/analysis/commands.ts`; the CLI file is thin command registration.
- `src/cli/simulate.ts`: simulation behavior now lives in `src/core/evidence/commands.ts`; the CLI file is thin command registration.
- `src/cli/preflight.ts`: preflight planning, coverage, packet helpers, audit/report helpers, and command behavior have moved to `core/preflight`; the legacy `src/preflight/` module cluster is gone. Remaining cleanup is mostly slimming adjacent CLI files.
- `src/cli/instrumentation.ts`: instrumentation command behavior now lives in `core/instrumentation`; the CLI file is thin command registration.

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

1. Add project profile types, storage, and `growth project show/configure/route add/auth-context add`.
2. Change `init`, `status`, `llm-context`, `instrumentation plan`, and `preflight plan` to read the project profile.
3. Replace missing profile facts with structured blockers and next configure commands.
4. Remove remaining `detectFramework` calls from `init` and `doctor`, or make them explicit discovery/configuration commands.
5. Done: delete `scanSpaAgentContext`; make synthetic-context requirements part of the instrumentation contract instead of a source scan.
6. Done: delete `detectPostHogConventions` from preflight planning; require a configured connector or explicit connector import.
7. Done: delete `routeFromScenarios` and `firstRouteMention`; target route comes from explicit targeting domains, project routes, variant implementation URLs, or command flags.
8. Done: replace authenticated-targeting regexes with explicit project profile auth context fields.
9. Done: move preflight provider capability planning and generic raw pull fetching behind the connector adapter registry.
10. Done: move connector auth check/setup planning and Stripe Projects parsing behind adapter-owned functions.
11. Done: move connector add/import default config construction behind adapter `defaultConfig` functions.
12. Done: move event mapping behind adapter `mapEvent` functions.
13. Done: move preflight provider-backed continuation/audit decisions to adapter metadata.
14. Done: move runtime connector env/scope metadata to adapters.
15. Done: move connector coverage behind adapter `mappedEvents`.
16. Done: move provider-specific connector validation behind adapters.
17. Done: remove runtime `detectFramework` calls from `init` and `doctor`; `init` defaults to `unknown` unless `--framework` is explicit.
18. Done: canonicalize and validate explicit framework ids so aliases such as `nextjs` do not become silent generic instrumentation hints.
19. Done: move connector import command routing and connector file persistence behind adapter import results.
20. Done: move connector add command routing and connector file persistence behind connector helpers.
21. Done: add tests with fake repos containing provider strings beyond PostHog and a Statsig second-provider adapter smoke.
22. Done: move connector catalog defaults and PostHog capability helpers into connector-owned modules.
23. Done: remove hardcoded PostHog pull/auth recipes from generated skill workflows and `llm-context` command hints.
24. Done: delete the unused `detectFramework` source scanner.
25. Done: move preflight packet/run creation into `core/preflight`.
26. Done: move preflight run persistence, pull, complete, complete-local, dry-run, and audit behavior into `core/preflight`.
27. Done: move preflight report attachment and schema validation into `core/preflight`.
28. Done: move preflight planning into `core/preflight`.
29. Done: move preflight coverage, preflight types, and packet prompt helpers into `core/preflight`.
30. Done: move preflight audit, report, and markdown helpers into `core/preflight`.
31. Done: move instrumentation contract, sample, guidance, event-shape, and readiness helpers into `core/instrumentation`.
32. Done: move instrumentation endpoint/file verification IO into `core/instrumentation`.
33. Done: move instrumentation command behavior into `core/instrumentation`.
34. Done: add live Statsig provider pull through the Statsig adapter using the Console Events API response shape.
35. Done: move event-window and synthetic-traffic evidence primitives into `core/evidence`.
36. Done: move experiment, evidence simulation, and analysis modules out of `src/domain/` into owned `core/*` modules.
37. Done: move connector command behavior into `src/connectors/commands.ts`.
38. Done: move experiment command behavior into `src/core/experiment/commands.ts`.
39. Done: guard preflight route extraction so host-only targeting domains cannot become packet paths.
40. Done: add `growth experiment update --from-file` so agents can update specs without inline JSON shelling.
41. Done: move validation command behavior into `src/core/validation/commands.ts`.
42. Done: move analysis command behavior into `src/core/analysis/commands.ts`.
43. Done: move simulation command behavior into `src/core/evidence/commands.ts`.
44. Continue slimming adjacent CLI files and keep analysis isolated as optional legacy behavior.
