# Context

## Domain Terms

### Event Window

Half-open time interval: `after <= timestamp < before`. Events with missing or invalid timestamps do not count as preflight evidence.

### Preflight Coverage

The event surface a synthetic preflight run must exercise. Comes from every metric event, denominator event, and explicit instrumentation event. Packet scenarios may narrow what one agent tries, but the audit checks the full surface.

### Synthetic Traffic

Browser-agent traffic used to validate instrumentation and UX. Not real-user evidence. Identified by `agent_generated: true` and a non-empty `agent_run_id`. The URL param is named `variant` (to force assignment); the emitted event property is `variant_id`.

### Authenticated Targeting

Explicit signal that synthetic packets need an authenticated browser session. Comes from project profile auth contexts, not inferred from segment names or route prose.

### Provider Pull Capability

The read-side ability to fetch events from an analytics provider. PostHog app telemetry (analytics key + host) can be ready while provider pull is still blocked on a project id. Growth reports this as a blocked `provider_pull` capability, not broken telemetry.

### Connector Adapter

Provider-specific implementation behind Growth's connector interface. Growth core calls adapters for capability status, config, mapping, coverage, and pull. It does not branch on provider names.

### Project Profile

Explicit Growth-owned app facts: framework, app URLs, routes, auth contexts. Written by commands (`growth init`, `growth project configure`), consumed by planning. Runtime planning does not scan source or dependencies.

### Variant Implementation

Optional metadata on a variant pointing to its code artifact: branch, worktree, commit, PR URL, app URL. Does not change assignment semantics — exists for review, rollback, and variant-specific preflight.
