# Context

## Domain Terms

### Event Window

An event window is the time interval used to decide whether events belong to a growth run, especially a synthetic preflight packet run or connector pull.

Event windows are half-open: an event is inside the window when `after <= timestamp < before`. This keeps adjacent windows from double-counting events at the shared edge.

Events with missing or invalid timestamps must not count as preflight evidence. In a preflight audit, missing or invalid event timestamps fail the relevant audit check and should be reported as evidence. For prepared preflight runs, local event overrides still use the recorded event window. Dry-run evidence may use an explicit all-local-evidence window.

### Preflight Coverage

Preflight coverage is the event surface that a synthetic preflight packet run is expected to exercise before an experiment can be considered ready for provider-backed preflight or launch-readiness audit.

The required preflight coverage surface comes from every metric event, every metric denominator event, and every explicit instrumentation event on the experiment. Packet scenarios may narrow the event surface a single synthetic preflight packet should try to exercise, but the audit trail checks the full required preflight coverage surface for the run.

### Synthetic Traffic

Synthetic traffic is browser-agent or simulation traffic used to validate instrumentation and UX. It is not real-user evidence and must not drive ship decisions.

Synthetic traffic identity is carried by the `agent_generated` and `agent_run_id` event payload properties. Synthetic preflight packet URLs carry `agent_generated`, `agent_run_id`, `experiment_id`, and `variant` query params. The emitted event property remains `variant_id`; the URL param is named `variant` only to force assignment for a synthetic preflight packet.

Events count as synthetic when `agent_generated` is `true`. A synthetic preflight event is correctly labeled only when `agent_generated` is `true` and `agent_run_id` is a non-empty string.

### Authenticated Targeting

Authenticated targeting is an experiment target signal indicating that synthetic packets need an authenticated browser session. It should be explicit in the experiment spec or project profile, not inferred from free-form segment names or route prose.

The signal drives assignment identity guidance, synthetic context capture before auth redirects or client navigation, and preflight browser context requirements. If Growth does not know whether a target route requires auth, it should report that unknown explicitly instead of guessing from strings such as authenticated, signed-in, logged-in, `session.user`, or `user_id`.

### Preflight Audit Trail

The preflight audit trail is the launch-readiness record produced from a growth run's synthetic preflight packet reports, pulled or local events, event window evidence, latest local instrumentation verification, and provider-backed connector evidence.

The audit trail policy is separate from evidence loading. Evidence loading may read the store, reports, connectors, and run artifacts. The audit trail policy should be testable from in-memory evidence and is responsible for checks, evidence summaries, and the final recommendation.

### Analysis Evidence

Analysis evidence is the experiment definition, assignments, events, selected analysis segment, and analysis timestamp used to produce statistical analysis and a ship recommendation.

The analysis policy is separate from evidence loading. Evidence loading may read the store and resolve the experiment. The analysis policy should be testable from in-memory evidence and is responsible for segment filtering, per-variant metric analysis, significance comparisons, and recommendation logic.

### Connector Catalog

The connector catalog is the canonical source of connector kinds, default connector configs, mapping conventions, auth env defaults, required scopes, and connector event coverage rules.

CLI commands and pull adapters may read or write connector files, discover provider metadata, and check env values. They should not duplicate connector defaults or mapping conventions that belong to the connector catalog.

### Provider Pull Capability

Provider pull capability is the read-side ability to fetch events back from an analytics provider for provider-backed preflight or analysis.

PostHog app telemetry can be configured with the analytics key and host while provider pull is still blocked. Provider-backed PostHog pulls additionally need a project id because the pull adapter reads from project-scoped event APIs.

Growth should report this as a blocked `provider_pull` capability, not as broken app telemetry.

### Connector Adapter

A connector adapter is the provider-specific implementation behind Growth's connector interface.

Growth core should ask connector adapters for discovery, default config, capability status, setup plans, event mapping, coverage, and pull behavior. Growth core should not branch on provider names such as PostHog or Statsig when deciding evidence readiness or preflight flow.

Built-in adapters can live in the repo first. External connector plugins should come later after the adapter interface has been proven by at least PostHog, local JSONL, and one non-PostHog provider.

### Project Profile

A project profile is the explicit Growth-owned description of app facts needed by the control plane: framework, app URLs, known routes, auth contexts, connector sources, and runtime adapters.

Project profiles are written by explicit commands such as `growth init`, `growth project configure`, or connector/framework import commands. Runtime planning commands should consume the project profile and experiment spec. They should not scan source text, dependency names, route prose, or provider strings to infer framework, provider, route, or auth facts.

When a required project fact is missing, Growth should return a structured unknown or blocker with the command needed to configure it. Unknown is better than a guessed default.

### App URL Resolver

The app URL resolver chooses the browser URL Growth should hand to synthetic preflight packets and agent guidance.

Resolution is part of the Growth control plane. Agents should not infer local ports or hardcode `localhost` when Growth can derive a URL from explicit command input, Portless runtime context, Growth local state, or declared project profile values.

### Variant Implementation

A variant implementation is optional metadata on an experiment variant that points to the concrete code artifact for that variant: branch, worktree, commit, PR URL, app URL, and implementation status.

Variant implementation metadata does not change assignment or analysis semantics. Experiments still analyze one experiment id and canonical `variant_id`; the metadata exists to make review, rollback, and variant-specific preflight concrete.
