# Architecture

## Source Layout

```
src/
  cli/             # Thin command registration — parses args, calls core, wraps result
  core/
    experiment/    # Experiment schema, types, builder, assignment, targeting, commands
    instrumentation/ # Contracts, verification, instrumentation commands
    evidence/      # Event windows, synthetic traffic primitives
    preflight/     # Planning, packets, runs, audit, coverage, reports
    validation/    # Config validation commands
  connectors/
    registry.ts    # Adapter lookup by kind/source/import-provider
    types.ts       # Adapter interface and capability types
    posthog/       # PostHog adapter: config, capabilities, auth, pull
    local/         # Local JSONL adapter: config, file-based pull
  lib/             # Infrastructure: store, state, env, paths, envelope, framework defaults
```

## Connector Adapter Interface

Growth core speaks generic connector concepts. Provider-specific behavior lives behind adapters.

Core calls: `capabilityStatus`, `coverage`, `authCheck`, `authSetup`, `pullEvents`, `mapEvent`, `defaultConfig`.

No `if (kind === 'posthog')` in preflight planning, pull, or CLI files.

## Project Profile

App facts are explicit Growth state, not runtime guesses:

- `growth project configure --framework nextjs-app-router --app-url <url>`
- `growth project route add <id> --path <path>`
- `growth project auth-context add <id> --requires-session`

Runtime planning consumes the profile. It does not scan source, dependencies, or prose.

## No Runtime Heuristics

- No searching `package.json` or source for framework/provider strings
- No deriving routes from scenario prose or targeting segment names
- No inferring auth requirements from free-form text
- Unknown facts are blockers with explicit configure commands, not guessed defaults

## Readiness Tiers

`blocked` → `static_ready` → `local_synthetic_ready` → `provider_preflight_passed`

Each tier is a gate. Preflight planning reports the current tier, ceiling, and blockers.

## Deferred

- Statistical analysis (removed — rebuild from evidence primitives when needed)
- Additional provider adapters (interface is proven, add when needed)
- External connector plugins (runtime plugin loading, trust, sandboxing)
- Direct agent launch backends (Growth prepares packets, outer agent executes)
