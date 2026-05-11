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

### Preflight Audit Trail

The preflight audit trail is the launch-readiness record produced from a growth run's synthetic preflight packet reports, pulled or local events, event window evidence, latest local instrumentation verification, and provider-backed connector evidence.

The audit trail policy is separate from evidence loading. Evidence loading may read the store, reports, connectors, and run artifacts. The audit trail policy should be testable from in-memory evidence and is responsible for checks, evidence summaries, and the final recommendation.

### Analysis Evidence

Analysis evidence is the experiment definition, assignments, events, selected analysis segment, and analysis timestamp used to produce statistical analysis and a ship recommendation.

The analysis policy is separate from evidence loading. Evidence loading may read the store and resolve the experiment. The analysis policy should be testable from in-memory evidence and is responsible for segment filtering, per-variant metric analysis, significance comparisons, and recommendation logic.

### Connector Catalog

The connector catalog is the canonical source of connector kinds, default connector configs, mapping conventions, auth env defaults, required scopes, and connector event coverage rules.

CLI commands and pull adapters may read or write connector files, discover provider metadata, and check env values. They should not duplicate connector defaults or mapping conventions that belong to the connector catalog.
