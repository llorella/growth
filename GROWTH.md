# Growth Spec

Status: current implementation spec
Date: 2026-05-11
Working name: `growth`

## 1. Executive Summary

`growth` is a deterministic, repo-local control plane for running growth experiments with coding agents.

The product should rhyme with Stripe Projects:

- a CLI that agents can safely operate inside a repository
- a managed local state directory
- JSON output everywhere
- strict schemas and catalogs instead of guessing
- generated repo-local agent guidance
- provider and connector setup through deterministic commands
- status as the grounding primitive
- sensitive files and credentials hidden behind tool APIs

It should borrow from PostHog Wizard only where nondeterminism is useful:

- bounded agent/browser runs
- framework-aware instrumentation guidance
- safe helper tools for env/package/project detection
- progress and report protocols
- skill/playbook installation
- final run reflections that improve future prompts

The core thesis:

```text
growth owns the experiment contract, state, connectors, event windows, analysis, verification, and audit.

The outer coding agent owns product interpretation and code changes.

Optional bounded agents exercise the app like synthetic users and generate labeled telemetry.
```

Current implementation snapshot:

- CLI commands exist for `init`, `status`, `schema`, `catalog`, `experiment`, `instrumentation`, `connector`, `env`, `pull`, `simulate`, `preflight`, `analyze`, `power-calc`, and MCP tool wrapping.
- `preflight` is the current name for browser-agent synthetic validation. Older `cohort` command names are not part of the current command surface.
- Synthetic traffic is labeled by event payload properties `agent_generated: true` and non-empty `agent_run_id`; preflight URLs carry `agent_generated`, `agent_run_id`, `experiment_id`, and forced-branch query param `variant`.
- Emitted app events use `variant_id` as the canonical variant property. The `variant` query param exists only to force a synthetic preflight branch.
- Event windows are half-open: `after <= timestamp < before`. Missing or invalid timestamps do not count as preflight evidence.
- Preflight coverage is derived from metric events, denominator events, and explicit instrumentation events. Packet scenarios may narrow what one agent tries, but the audit checks the full required coverage surface.
- A local-only successful preflight returns `ready_for_provider_preflight`; a provider-backed synthetic pull can return `provider_preflight_passed`; neither is a real-user ship decision.
- Analysis policy is separated from evidence loading and only `growth analyze --segment real-users` can support production ship decisions.
- Connector defaults, auth env conventions, required scopes, mapping conventions, and coverage rules live in the connector catalog.

The first concrete loop:

```text
hypothesis
  -> experiment config
  -> instrumentation contract
  -> app code changes by a coding agent
  -> synthetic preflight packets
  -> local or provider-backed synthetic events
  -> launch to real users
  -> real product events from connectors
  -> deterministic pull into growth
  -> statistical analysis
  -> recommendation and audit report
```

This is not a generic "tool that creates tools" as the lead product. Runbook can remain an internal chassis or reference implementation. The user-facing product should be `growth` because the domain has real pressure: teams want to run experiments, connect analytics, generate validation traffic, and make decisions without building bespoke agent skills for every experiment.

## 2. Source Lessons

### 2.1 Stripe Projects Lesson

Stripe Projects is a deterministic subtool inside a broader coding-agent workflow.

It does not try to be the whole agent runner. It assumes an outer coding agent is already editing the codebase. Stripe Projects provides the safe path for external services, state, credentials, provider context, and env synchronization.

Observed patterns:

- `stripe projects init` scaffolds agent-facing repo files:
  - `.agents/skills/stripe-projects-cli/SKILL.md`
  - `.claude/skills/stripe-projects-cli`
  - `.cursor/rules/stripe-projects-cli.mdc`
  - `AGENTS.md`
  - `CLAUDE.md`
- generated guidance tells agents to:
  - run `stripe projects llm-context`
  - inspect with `stripe projects status`
  - browse exact provider/service slugs through `stripe projects catalog`
  - provision with `stripe projects add`
  - pull env with `stripe projects env --pull`
- CLI-managed files are explicit boundaries:
  - do not hand-edit `.projects`
  - do not inspect `.env`
  - use the CLI for redacted env views and writes
- `--json` suppresses interactive prompts and is described as ideal for agents
- agent sessions default to non-interactive output
- JSON output uses a consistent envelope with:
  - `ok`
  - `command`
  - `version`
  - `data` or `error`
  - `warnings`
  - `next_steps`
  - `meta`

For `growth`, the equivalent is not "automatically edit every app." It is:

```text
make growth experimentation safe, inspectable, resumable, and machine-operable
inside the larger coding-agent loop.
```

### 2.2 PostHog Wizard Lesson

The PostHog Wizard is a controlled Claude Code harness, not just a template installer.

The deterministic package owns:

- detection
- auth
- health checks
- flow state
- TUI progress
- prompt assembly
- MCP wiring
- local helper tools
- tool permissions
- protected file policy
- final report collection

The agent owns:

- inspecting the target project
- choosing the right framework-specific skill
- editing app code
- creating instrumentation
- using PostHog MCP for assets
- producing a setup report

Important transferable patterns:

- keep the durable runner separate from updatable skills/playbooks
- route sensitive operations through deterministic local tools
- expose a small progress/report protocol rather than hardcoding every possible subtask
- deny raw `.env*` reads/writes and provide helper tools instead
- capture post-run remarks as product telemetry
- allow large-context agents to read real project code, but only inside rails

For `growth`, the Wizard lesson applies to instrumentation and synthetic preflight execution, not to the whole product. `growth` should be Stripe-like at the top level and Wizard-like for bounded workflows that need an agent to interpret or exercise an app.

### 2.3 Every / every-exp Lesson

The Every work already prototyped the combined pattern.

`~/every-exp` contributed:

- strict experiment JSON Schema
- CLI-first commands with `--json`
- MCP server exposing experiment tools
- deterministic sticky assignment
- file-backed experiment store
- connector JSON files for PostHog, Segment, Stripe, native apps
- statistical analysis with primary, secondary, and guardrail metrics
- structured recommendations such as:
  - `ship_treatment`
  - `keep_running`
  - `stop_inconclusive`
  - `rollback`
  - `guardrail_breach`

`~/every` contributed:

- real product UI with control and treatment flows
- PostHog event capture through a first-party proxy
- typed event taxonomy
- deterministic user variant assignment
- `agent_generated` and `agent_run_id` event properties
- browser-agent exercise of onboarding flows
- a product surface agents could use without inspecting source

The sessions contributed the key insight:

```text
parallel browser agents naturally became synthetic first-time users,
generated real PostHog events, and closed the loop back into the deterministic
experiment framework.
```

That should not remain an ad hoc trick. It should become a first-class `growth` concept: a synthetic preflight run.

### 2.4 Runbook Lesson

Runbook is useful as an internal architecture pattern:

- deterministic runner
- playbook skill
- status/read model
- workflow steps
- approvals
- local MCP
- audit logs
- agent packets
- verification hooks

But leading with Runbook is too meta right now. `growth` should be the product. Runbook can influence implementation details, but the user should experience a concrete growth experimentation tool.

## 3. Product Positioning

### 3.1 What `growth` Is

`growth` is an agent-native growth experimentation control plane.

It helps a growth engineer and coding agent:

1. capture a hypothesis as a structured experiment
2. define variants, metrics, guardrails, schedule, and sample-size assumptions
3. generate an app instrumentation contract
4. connect event sources such as PostHog, Segment, Stripe, native apps, and warehouses
5. verify that the app emits required events
6. prepare bounded synthetic preflight runs
7. pull events into a local or production store
8. analyze outcomes
9. produce recommendations and audit trails

### 3.2 What `growth` Is Not

`growth` is not:

- a replacement for PostHog, GrowthBook, Statsig, or Optimizely
- a dashboard-first experimentation product
- a generic agent workflow generator as the primary user story
- a coding agent by itself
- proof that synthetic-agent traffic predicts real users
- a secret store that encourages agents to read raw credentials

It can integrate with dashboards, experimentation platforms, and coding agents, but its primary value is the deterministic substrate that agents can operate.

### 3.3 Why Not Just a Skill?

A skill alone can say:

```text
Launch N browser agents, record their reports, pull PostHog events, and analyze.
```

That is not enough because the high-value pieces are deterministic bookkeeping:

- run IDs
- preflight run IDs
- agent IDs
- browser names
- URL parameters
- batch start/end windows
- report schemas
- event attribution
- pull idempotency
- audit logs
- warnings
- next steps
- reproducible analysis

Those belong in `growth` state and command outputs, not in prompt convention.

The skill should teach the outer coding agent how to operate `growth`. The `growth` CLI should own the actual run contract.

## 4. User Model

### 4.1 Primary User

A growth engineer who works with coding agents and wants to run more experiments without losing rigor.

They are comfortable with:

- CLI workflows
- app code
- analytics systems
- structured configs
- agent collaboration

They do not want:

- one-off spreadsheet stats
- ad hoc PostHog queries per experiment
- manual event mapping each time
- prompt-only coordination of subagents
- dashboards that agents cannot operate

### 4.2 Secondary User

A coding agent operating inside a repository.

The coding agent needs:

- a stable command surface
- machine-readable status
- explicit schemas
- exact catalogs
- non-interactive modes
- verification commands
- clear boundaries around managed files and secrets

### 4.3 Tertiary User

A future agent runner or orchestration system.

It needs:

- prepared packets
- policies
- report schemas
- MCP tools
- run state
- audit data
- backend-agnostic execution contracts

## 5. Design Principles

### 5.1 Status First

Agents should start with:

```bash
growth status --json
```

`status` is the grounding primitive. It should summarize:

- whether the repo is initialized
- detected framework
- configured connectors
- env/auth readiness without revealing secrets
- active experiments
- missing instrumentation
- recent runs
- recommended next commands

### 5.2 Schemas Before Creation

Agents should read schemas before generating configs:

```bash
growth schema experiment --json
growth schema connector --json
growth schema preflight-report --json
```

Strict schemas should be preferred over permissive schemas. Agents do better with explicit constraints.

### 5.3 Catalogs Instead Of Guessing

Agents should not invent provider names, event names, or template IDs.

Use:

```bash
growth catalog --json
growth connector list --json
growth template list --json
growth event-taxonomy list --json
```

### 5.4 Deterministic Boundaries For Sensitive Operations

Agents should not read or write raw env files directly.

Use:

```bash
growth env check --json
growth env set --key POSTHOG_ANALYTICS_API_KEY --stdin --json
growth env set --key POSTHOG_ANALYTICS_HOST --from-env POSTHOG_ANALYTICS_HOST --json
growth connector auth check posthog --json
```

Values should be redacted by default. Presence and host can be surfaced safely.

### 5.5 Prepared Preflight Runs Before Launched Agent Runs

`growth` should first prepare run packets. It does not need to launch subagents in v1.

Prepared packets are backend-agnostic:

```bash
growth preflight prepare demand-driven-onboarding --agents 4 --browser --json
```

Direct launch backends remain future work. The current implementation writes packet prompts, URLs, tool policies, report schemas, and a launch manual for the outer agent or runner to execute.

### 5.6 Synthetic Traffic Is A Validation Layer, Not Evidence

Agent-generated events are useful for:

- validating instrumentation
- checking end-to-end attribution
- exercising control/treatment flows
- generating demo traffic
- surfacing qualitative UX confusion
- verifying queries, connectors, and analysis

They are not proof of real-user behavior.

Every synthetic event must be labeled:

```json
{
  "agent_generated": true,
  "agent_run_id": "preflight_20260511T120000Z_agent_1"
}
```

### 5.7 Analysis Must Be Conservative

`growth analyze` should:

- compare treatment variants against control
- treat guardrails as blocking
- report insufficient data clearly
- distinguish real user segments from synthetic agent segments
- avoid recommending ship from synthetic-only evidence
- include next steps
- include caveats and warnings

## 6. Repository Artifacts

Default layout:

```text
.growth/
  state.json
  state.local.json
  audit.jsonl
  experiments/
    <experiment_id>.json
  connectors/
    posthog.json
    segment.json
    stripe.json
    native-app.json
  event-taxonomy.json
  templates/
    conversion-test.json
    activation-test.json
    pricing-test.json
  runs/
    preflight_<timestamp>Z/
      run.json
      agent-packets/
        agent-1.prompt.txt
        agent-1.policy.json
        agent-1.report.schema.json
        agent-1.url.txt
      reports/
      pulls/
      audit.md
      launch.manual.md

.agents/
  skills/
    growth/
      SKILL.md
      schema.md
      workflows/
        create-experiment.md
        instrument-app.md
        run-preflight.md
        pull-and-analyze.md

.claude/
  skills/
    growth -> ../../.agents/skills/growth

.cursor/
  rules/
    growth.mdc

AGENTS.md
CLAUDE.md
```

### 6.1 Managed Files

Managed by `growth`:

- `.growth/state.json`
- `.growth/state.local.json`
- `.growth/audit.jsonl`
- `.growth/runs/**`
- generated sections inside `AGENTS.md`
- generated sections inside `CLAUDE.md`
- `.agents/skills/growth/SKILL.md`
- `.claude/skills/growth` symlink
- `.cursor/rules/growth.mdc`

Default guidance should tell agents:

- do not edit `.growth/state.json` directly
- do not edit `.growth/state.local.json` directly
- do not read raw `.env*`
- use `growth` commands for state, env, and connector actions

### 6.2 User-Editable Managed Configs

Some files should be intentionally editable by humans and agents, but validated by `growth`:

- `.growth/experiments/<id>.json`
- `.growth/connectors/<source>.json`
- `.growth/event-taxonomy.json`
- `.growth/templates/*.json`

Even for editable files, the recommended path is:

```bash
growth experiment create ...
growth connector add ...
growth connector validate ...
```

Manual edits should be followed by:

```bash
growth validate --json
```

## 7. Command Surface

### 7.1 Global Options

All commands should support:

```bash
--json
--root <dir>
--no-interactive
--yes
--verbose
```

`--json` should:

- force JSON envelope output
- suppress spinners
- suppress prompts
- include `next_steps`
- include machine-readable error codes

`--no-interactive` should:

- fail clearly instead of hanging
- require all necessary flags

### 7.2 JSON Envelope

Every command should use a shared envelope:

```json
{
  "ok": true,
  "command": "growth status",
  "version": "0.1",
  "data": {},
  "error": null,
  "warnings": [],
  "next_steps": [],
  "meta": {
    "project_initialized": true,
    "root": "/repo",
    "framework": "nextjs-app-router",
    "connectors_configured": ["posthog"],
    "experiments_count": 1,
    "active_runs_count": 0
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "command": "growth pull demand-driven-onboarding",
  "version": "0.1",
  "error": {
    "code": "MISSING_API_KEY",
    "message": "PostHog analytics API key is missing.",
    "details": {
      "connector": "posthog",
      "required_env": "POSTHOG_ANALYTICS_API_KEY"
    }
  },
  "warnings": [],
  "next_steps": [
    "Set POSTHOG_ANALYTICS_API_KEY without exposing the value.",
    "Run growth connector auth check posthog --json."
  ],
  "meta": {
    "project_initialized": true
  }
}
```

### 7.3 Initialization

```bash
growth init
growth init --framework nextjs-app-router
growth init --bare
growth init --json
```

Responsibilities:

- detect framework
- create `.growth`
- create initial state
- copy built-in templates/connectors
- scaffold agent skill
- scaffold Claude skill link
- upsert managed `AGENTS.md` section
- upsert `CLAUDE.md`
- write Cursor rule
- update `.gitignore` for sensitive files if needed

Output data:

```json
{
  "root": "/repo",
  "framework": "nextjs-app-router",
  "files": {
    ".growth/state.json": "created",
    ".agents/skills/growth/SKILL.md": "created",
    ".claude/skills/growth": "created",
    "AGENTS.md": "updated",
    "CLAUDE.md": "updated"
  }
}
```

### 7.4 Status

```bash
growth status --json
growth status <experiment_id> --json
```

Project status should include:

- root
- framework
- initialized files
- connector readiness
- env key presence
- experiment summaries
- run summaries
- validation warnings

Experiment status should include:

- config validity
- lifecycle status
- required events
- observed events
- assignment counts
- event counts
- segments:
  - all
  - real users
  - agent generated
- latest analysis
- missing instrumentation

### 7.5 LLM Context

```bash
growth llm-context --json
growth llm-context --experiment demand-driven-onboarding --json
growth llm-context --fetch --json
```

Responsibilities:

- return agent usage guide
- return current project state summary
- return available schemas and catalogs
- return experiment-specific instrumentation contract
- sync provider-specific skills if connectors supply guidance URLs
- include non-interactive command examples

Agent usage guide:

```json
{
  "flags": {
    "--json": "Always pass for structured output.",
    "--no-interactive": "Fail clearly instead of prompting.",
    "--yes": "Skip confirmation prompts when safe."
  },
  "workflow": [
    "growth status --json",
    "growth schema experiment --json",
    "growth experiment create <id> --from-json ... --json",
    "growth instrumentation plan <id> --json",
    "growth instrumentation verify <id> --json",
    "growth preflight prepare <id> --agents 4 --browser --json",
    "growth preflight pull <run_id> --source posthog --json",
    "growth preflight audit <run_id> --json",
    "growth pull <id> --source posthog --json",
    "growth analyze <id> --json"
  ]
}
```

### 7.6 Schemas

```bash
growth schema experiment --json
growth schema connector --json
growth schema event-taxonomy --json
growth schema preflight-report --json
```

Schemas should be strict and explain agent-facing conventions.

### 7.7 Catalog

```bash
growth catalog --json
growth catalog connectors --json
growth catalog templates --json
growth catalog events --json
growth catalog metrics --json
```

The catalog should prevent guessing.

Catalog entries:

- connector IDs:
  - `posthog`
  - `segment`
  - `stripe`
  - `native-app`
  - `warehouse`
- templates:
  - `conversion-test`
  - `activation-test`
  - `pricing-test`
  - `onboarding-test`
  - `cross-sell-test`
- metric archetypes:
  - conversion rate
  - activation rate
  - retention proxy
  - revenue per visitor
  - time to value
  - support burden
  - escape hatch rate
- workflow IDs:
  - `create-experiment`
  - `instrument-app`
  - `prepare-preflight`
  - `pull-analyze`

### 7.8 Experiments

```bash
growth experiment create <id> --from-json '<json>' --json
growth experiment create <id> --template activation-test --json
growth experiment list --json
growth experiment show <id> --json
growth experiment update <id> --from-json '<json>' --json
growth experiment start <id> --json
growth experiment stop <id> --reason "..." --json
growth experiment archive <id> --json
```

Creation should validate:

- ID format
- hypothesis length and shape
- at least two variants
- first variant is control
- weights sum to 100 or can be normalized with warning
- exactly one primary metric
- guardrails have thresholds
- sample size exists or can be computed
- schedule has min and max runtime
- required events exist in event taxonomy or are explicitly new

### 7.9 Power Calculation

```bash
growth power-calc --baseline 0.15 --mde 0.2 --daily-traffic 500 --json
```

Output:

```json
{
  "per_variant": 2400,
  "total": 4800,
  "estimated_days": 10,
  "inputs": {
    "baseline_rate": 0.15,
    "minimum_detectable_effect": 0.2,
    "power": 0.8,
    "alpha": 0.05
  }
}
```

### 7.10 Instrumentation

```bash
growth instrumentation plan <experiment_id> --json
growth instrumentation verify <experiment_id> --json
growth instrumentation sample <experiment_id> --json
growth instrumentation events <experiment_id> --json
```

`plan` should produce:

- required assignment behavior
- required event names
- required event properties
- source files likely to change based on framework detection
- verification steps
- recommended coding-agent prompt packet

For a Next.js app, example output:

```json
{
  "framework": "nextjs-app-router",
  "required_contract": {
    "assignment": {
      "stable_by": "user_id",
      "properties": ["experiment_id", "variant_id", "user_id"]
    },
    "events": [
      {
        "event": "signup_completed",
        "required_properties": ["experiment_id", "variant_id", "user_id", "session_id", "timestamp", "agent_generated", "agent_run_id"]
      },
      {
        "event": "second_app_activated",
        "required_properties": ["experiment_id", "variant_id", "user_id", "first_app", "second_app", "agent_generated", "agent_run_id"]
      }
    ],
    "agent_traffic": {
      "required_properties": ["agent_generated", "agent_run_id"],
      "query_params": ["agent_generated", "agent_run_id", "experiment_id", "variant"]
    }
  },
  "suggested_files": [
    "src/lib/events.ts",
    "src/app/api/events/route.ts",
    "src/lib/assignment.ts"
  ],
  "next_steps": [
    "Edit the app to satisfy the event contract.",
    "Run growth instrumentation verify demand-driven-onboarding --json."
  ]
}
```

`verify` should avoid relying solely on static code inspection. It should support:

- static checks where useful
- synthetic event samples
- local event endpoint checks
- browser-agent dry runs
- connector mapping tests

### 7.11 Connectors

```bash
growth connector list --json
growth connector add posthog --json
growth connector add local --events-file tmp/events.jsonl --json
growth connector import stripe-projects --json
growth connector show posthog --json
growth connector validate posthog --json
growth connector auth check posthog --json
```

Connector config:

```json
{
  "source": "posthog",
  "kind": "posthog",
  "user_id_path": "distinct_id",
  "anonymous_id_path": "properties.$anon_distinct_id",
  "experiment_id_path": "properties.experiment_id",
  "variant_id_path": "properties.variant_id",
  "event_name_path": "event",
  "timestamp_path": "timestamp",
  "idempotency_key_path": "uuid",
  "posthog": {
    "host": "https://us.posthog.com",
    "api_key_env": "POSTHOG_ANALYTICS_API_KEY"
  },
  "mappings": {
    "signup_completed": {
      "framework_event": "signup_completed",
      "payload_paths": {
        "plan": "properties.plan",
        "agent_generated": "properties.agent_generated",
        "agent_run_id": "properties.agent_run_id"
      }
    }
  }
}
```

Connector rules:

- unmapped source events are dropped with counters
- missing user IDs are dropped with counters
- missing assignment is surfaced clearly
- explicit `experiment_id` and `variant_id` override assignment lookup
- PostHog's legacy `properties.variant` is accepted as a fallback when `properties.variant_id` is absent
- if no explicit experiment exists, use running assignments for that user
- every emitted event needs a deterministic idempotency key when available

### 7.12 Pull

```bash
growth pull <experiment_id> --source posthog --after <iso> --before <iso> --json
growth pull <experiment_id> --source local --before <iso> --json
```

Requirements:

- default `after` from the source/experiment cursor, or 24 hours ago when no cursor exists
- support explicit half-open windows with `--after` and `--before`
- store pull record
- dedupe events
- dedupe assignments
- report drop reasons
- report source query details without leaking secrets
- warn on overlapping pull windows
- require confirmation for known overlapping windows unless `--yes`

Output:

```json
{
  "experiment_id": "demand-driven-onboarding",
  "source": "posthog",
  "window": {
    "after": "2026-04-28T18:14:43Z",
    "before": "2026-04-28T18:30:00Z"
  },
  "assignments_created": 4,
  "events_ingested": 29,
  "events_deduped": 3,
  "events_dropped": 0,
  "drop_reasons": {},
  "segments": {
    "agent_generated_true": 29,
    "agent_generated_false": 0,
    "agent_generated_missing": 0
  }
}
```

### 7.13 Analyze

```bash
growth analyze <experiment_id> --json
growth analyze <experiment_id> --segment real-users --json
growth analyze <experiment_id> --segment agent-generated --json
growth analyze <experiment_id> --segment all --json
```

Recommendations:

- `ship_treatment`
- `keep_running`
- `stop_inconclusive`
- `rollback`
- `guardrail_breach`
- `instrumentation_incomplete`
- `synthetic_only_no_ship`

If analysis only contains agent-generated traffic, the action must not be `ship_treatment`. Instead:

```json
{
  "action": "synthetic_only_no_ship",
  "confidence": "high",
  "reasoning": "Only agent-generated synthetic traffic is present. Use this result to validate instrumentation and UX, not to make a production ship decision.",
  "next_steps": [
    "Start the experiment for real users.",
    "Keep monitoring guardrails.",
    "Use preflight reports for qualitative UX issues."
  ]
}
```

### 7.14 Preflight

```bash
growth preflight prepare <experiment_id> --agents 4 --browser --json
growth preflight show <run_id> --json
growth preflight attach-report <run_id> --agent 1 --file agent-1.report.json --json
growth preflight complete <run_id> --json
growth preflight complete-local <run_id> --events-file tmp/events.jsonl --json
growth preflight dry-run <experiment_id> --events-file tmp/events.jsonl --json
growth preflight pull <run_id> --source posthog --json
growth preflight audit <run_id> --json
```

`prepare` should create:

- run record
- agent IDs
- browser names
- URLs with:
  - `agent_generated=true`
  - `agent_run_id=<run_id>_agent_<n>`
  - `experiment_id=<experiment_id>`
  - forced `variant=<variant_id>` when balancing or explicitly requested
- prompt files
- tool policy files
- report schemas
- launch instructions
- event pull window start marker

Default preflight prompt:

```text
You are acting as a first-time user of this product.

Use only the browser tool specified in your packet. Do not inspect source code,
localStorage, network logs, analytics dashboards, repository files, environment
variables, or implementation details. Do not modify files.

Open the provided URL. Complete onboarding as naturally as you can. Make your own
choices. If the product gives multiple plausible paths, choose what seems useful
to you. Stop when you believe onboarding is complete or when you are genuinely
stuck.

Return a structured report matching the provided schema.
```

Report schema:

```json
{
  "type": "object",
  "properties": {
    "primary_goal_observed": { "type": "boolean" },
    "stopped_at_url": { "type": "string" },
    "stop_reason": {
      "type": "string",
      "enum": ["completed", "stuck", "error", "skipped"]
    },
    "path_taken": {
      "type": "array",
      "items": { "type": "string" }
    },
    "email_used": { "type": ["string", "null"] },
    "variant_observed": { "type": ["string", "null"] },
    "primary_surface_observed": { "type": ["string", "null"] },
    "primary_metric_events_observed": {
      "type": "array",
      "items": { "type": "string" }
    },
    "guardrail_observed": { "type": "boolean" },
    "confusing_or_broken": {
      "type": "array",
      "items": { "type": "string" }
    },
    "blockers": {
      "type": "array",
      "items": { "type": "string" }
    },
    "internal_ui_visible": {
      "type": "array",
      "items": { "type": "string" }
    },
    "missing_expected_events": {
      "type": "array",
      "items": { "type": "string" }
    },
    "screenshot_or_trace_artifacts": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": [
    "primary_goal_observed",
    "stopped_at_url",
    "stop_reason",
    "path_taken",
    "confusing_or_broken",
    "blockers",
    "internal_ui_visible",
    "missing_expected_events",
    "screenshot_or_trace_artifacts"
  ],
  "additionalProperties": false
}
```

Run directory:

```text
.growth/runs/preflight_20260511T120000Z/
  run.json
  batch-start.txt
  agent-packets/
    agent-1.prompt.txt
    agent-1.policy.json
    agent-1.report.schema.json
    agent-1.url.txt
    agent-2.prompt.txt
    ...
  reports/
  pulls/
  audit.md
  launch.manual.md
```

### 7.15 Preflight Audit

```bash
growth preflight audit <run_id> --json
growth preflight audit <run_id> --markdown
```

Preflight audit should combine:

- experiment config snapshot
- synthetic preflight packet snapshot
- agent reports
- pulled or local events
- event window evidence
- latest local instrumentation verification
- provider-backed connector evidence
- warnings
- next steps

Preflight audit must distinguish:

- quantitative event truth from analytics
- qualitative agent report truth from browser sessions
- local-only readiness from provider-backed readiness
- synthetic traffic from real-user analysis evidence

## 8. Data Model

### 8.1 Experiment

```ts
interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  owner?: string;
  status: "draft" | "running" | "stopped" | "completed" | "archived";
  variants: Variant[];
  metrics: Metric[];
  targeting?: Targeting;
  sample_size: SampleSize;
  schedule: Schedule;
  auto_stop?: AutoStop;
  instrumentation?: InstrumentationContract;
  preflight?: PreflightConfig;
  notes?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  stopped_at?: string;
  stop_reason?: string;
}
```

Rules:

- `id` is lowercase hyphenated
- `hypothesis` should be a full "We believe X will Y because Z" sentence
- first variant is control
- exactly one primary metric
- guardrails need thresholds
- schedule needs max duration
- sample size assumptions must be explicit

### 8.2 Variant

```ts
interface Variant {
  id: string;
  name: string;
  description?: string;
  weight: number;
}
```

### 8.3 Metric

```ts
interface Metric {
  id: string;
  name: string;
  role: "primary" | "secondary" | "guardrail";
  type: "proportion" | "continuous" | "count";
  direction: "higher_is_better" | "lower_is_better";
  event: string;
  denominator_event?: string;
  value_field?: string;
  guardrail_threshold?: number;
}
```

Metric conventions:

- proportion metrics should usually have denominator events
- one primary metric decides the experiment
- secondary metrics are diagnostic
- guardrails can block ship recommendations
- avoid metric stuffing

### 8.4 Assignment

```ts
interface Assignment {
  experiment_id: string;
  user_id: string;
  anonymous_id?: string;
  variant_id: string;
  assigned_at: string;
  source?: string;
  context?: Record<string, unknown>;
}
```

Assignment should be deterministic:

```text
sha256(experiment_id + ":" + user_id) -> weighted bucket
```

The same user in the same experiment should get the same variant across reloads and domains.

### 8.5 Event

```ts
interface GrowthEvent {
  id: string;
  experiment_id: string;
  user_id: string;
  anonymous_id?: string;
  variant_id: string;
  event: string;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
  idempotency_key?: string;
}
```

Required payload conventions:

```json
{
  "experiment_id": "demand-driven-onboarding",
  "variant_id": "treatment",
  "user_id": "user_123",
  "session_id": "session_123",
  "event_id": "evt_123",
  "timestamp": "2026-04-30T12:00:00Z",
  "agent_generated": false,
  "agent_run_id": null
}
```

### 8.6 Connector

```ts
interface ConnectorConfig {
  source: string;
  kind: "posthog" | "segment" | "stripe" | "native-app" | "warehouse" | "custom";
  user_id_path?: string;
  anonymous_id_path?: string;
  experiment_id_path?: string;
  variant_id_path?: string;
  event_name_path?: string;
  timestamp_path?: string;
  idempotency_key_path?: string;
  mappings: Record<string, ConnectorMapping>;
}
```

### 8.7 Run

```ts
interface GrowthRun {
  id: string;
  type: "preflight" | "instrumentation" | "pull" | "analysis";
  experiment_id?: string;
  status: "prepared" | "running" | "completed" | "failed" | "canceled";
  created_at: string;
  started_at?: string;
  completed_at?: string;
  event_window?: {
    after: string;
    before?: string;
  };
  agents?: AgentPacketSummary[];
  artifacts: Record<string, string>;
  warnings: Warning[];
}
```

## 9. State Model

### 9.1 `.growth/state.json`

Shared, commit-friendly state:

```json
{
  "version": "0.1",
  "project": {
    "name": "every",
    "framework": "nextjs-app-router",
    "initialized_at": "2026-04-30T00:00:00Z"
  },
  "connectors": {
    "posthog": {
      "status": "configured",
      "config_file": ".growth/connectors/posthog.json",
      "required_env": ["POSTHOG_ANALYTICS_API_KEY"],
      "required_scopes": []
    }
  },
  "experiments": {
    "demand-driven-onboarding": {
      "file": ".growth/experiments/demand-driven-onboarding.json",
      "status": "draft",
      "last_analysis_at": null
    }
  }
}
```

### 9.2 `.growth/state.local.json`

Machine-local state:

```json
{
  "version": "0.1",
  "env_files": [".env.local"],
  "connectors": {
    "posthog": {
      "host": "https://us.posthog.com",
      "project_id_present": true,
      "api_key_present": true,
      "last_auth_check_at": "2026-04-30T00:00:00Z"
    }
  },
  "local_servers": {
    "app_url": "http://localhost:3000"
  }
}
```

Never store raw secret values in this file.

### 9.3 `.growth/audit.jsonl`

Append-only command log:

```json
{"ts":"2026-04-30T00:00:00Z","command":"growth init","ok":true,"actor":"agent","run_id":null}
{"ts":"2026-05-11T00:05:00Z","command":"growth preflight prepare demand-driven-onboarding --agents 4","ok":true,"actor":"agent","run_id":"preflight_..."}
```

Audit events should include:

- command
- args with secrets redacted
- result status
- warnings
- next steps
- run ID
- experiment ID
- changed managed files

## 10. Agent Guidance

`growth init` should generate `.agents/skills/growth/SKILL.md`.

Suggested skill content:

```markdown
---
name: growth
description: Use the growth CLI to design, instrument, verify, run, pull, and analyze growth experiments in this repository.
allowed-tools: Bash(growth *) Read(.growth/experiments/*) Read(.growth/connectors/*) Read(.growth/event-taxonomy.json)
---

# growth

Start with:

growth status --json
growth llm-context --json

Rules:

- Do not read `.growth/state.local.json`.
- Do not read `.env*`.
- Do not hand-edit `.growth/state.json` or `.growth/audit.jsonl`.
- Use `growth schema experiment --json` before creating experiment configs.
- Use `growth instrumentation plan <id> --json` before editing app code.
- Use `growth instrumentation verify <id> --json` after editing app code.
- Use `growth preflight prepare`, not ad hoc browser-agent prompts.
- Use `growth pull` and `growth analyze`; do not rely on raw analytics screenshots.
- Never treat agent-generated traffic as real-user evidence.
```

`AGENTS.md` managed section:

```markdown
## growth

This repository is initialized for growth experiments.

Use the `growth` CLI as the control plane for experiments, connectors, synthetic preflights, pulls, analysis, and audit.

Start with `growth status --json`.
Use `growth llm-context --json` for current instructions.
Do not inspect managed state or env files directly.
```

`CLAUDE.md` can simply point to `AGENTS.md`, matching the Stripe Projects pattern.

## 11. MCP Surface

The MCP server should mirror the CLI, not create a separate product.

Resources:

- `growth://schema/experiment`
- `growth://schema/connector`
- `growth://schema/preflight-report`
- `growth://docs/conventions`
- `growth://status`
- `growth://catalog`

Tools:

- `growth_status`
- `growth_llm_context`
- `growth_experiment_create`
- `growth_instrumentation_plan`
- `growth_instrumentation_verify`
- `growth_preflight_prepare`
- `growth_preflight_dry_run`
- `growth_preflight_pull`
- `growth_preflight_audit`
- `growth_analyze`

Every MCP output should still be structured JSON.

## 12. Framework Detection

`growth init` and `growth status` should detect common frameworks:

- Next.js App Router
- Next.js Pages Router
- React/Vite
- Remix
- Astro
- SvelteKit
- Rails
- Django
- Flask/FastAPI
- generic Node
- unknown

Detection should affect:

- instrumentation plan suggestions
- package manager commands
- event proxy conventions
- env var names
- likely file paths
- verification strategy

For Next.js App Router:

- app event proxy likely lives under `src/app/api/events/route.ts`
- client instrumentation likely lives under `src/lib/events.ts`
- provider wrapper likely lives under `src/components/*Provider.tsx`
- reverse proxy can be configured in `next.config.ts`
- browser-agent preflight target is usually the local dev server URL

## 13. Security And Safety

### 13.1 Protected Files

Default protected globs:

```text
.env
.env.*
.growth/state.local.json
.growth/vault.json
.growth/runs/*/secrets/*
```

Agents should use:

```bash
growth env check --json
growth env set --key POSTHOG_ANALYTICS_API_KEY --stdin --json
growth connector auth check --json
```

### 13.2 Bash Policy For Launched Agents

If `growth` later launches agents directly, default allowed commands should be narrow:

- package manager install/build/test/lint/typecheck
- browser tool commands
- `growth` commands

Deny:

- arbitrary shell chaining
- raw env reads
- credential printing
- `cat .env*`
- `grep .env*`
- direct state mutation

### 13.3 Connector Auth

PostHog auth preflight should check:

- host
- analytics API key present

It should fail before a long run if the app's PostHog analytics key or host is missing.

## 14. Idempotency

This is a mandatory improvement over the current `every-exp` prototype.

Pulls must avoid duplicate events.

Dedupe keys, in priority order:

1. connector `idempotency_key_path`
2. source event ID
3. hash of:
   - source
   - experiment ID
   - user ID
   - variant ID
   - event name
   - timestamp
   - payload hash

Pull records should be stored:

```text
.growth/runs/<run_id>/pulls/posthog-20260430T120000Z.json
```

Overlapping windows should warn:

```json
{
  "code": "OVERLAPPING_PULL_WINDOW",
  "message": "This pull overlaps a previous PostHog pull for the same experiment."
}
```

With `--json --no-interactive`, overlapping pulls should fail unless `--yes` is passed.

## 15. Analysis Semantics

### 15.1 Primary Metric

The primary metric decides ship/no-ship for real traffic.

### 15.2 Secondary Metrics

Secondary metrics explain the primary result. They do not override primary unless encoded as guardrails.

### 15.3 Guardrails

Guardrails run before ship recommendations.

If a guardrail moves adversely and significantly:

```json
{
  "action": "guardrail_breach",
  "confidence": "high"
}
```

If a guardrail is adverse but not significant:

- include warning
- reduce confidence
- recommend continued monitoring

### 15.4 Insufficient Data

For very small samples, do not pretend.

Return:

```json
{
  "action": "keep_running",
  "confidence": "low",
  "reasoning": "Need at least 30 users per variant. Currently 2 / 5."
}
```

### 15.5 Synthetic Segment

Agent-generated traffic can validate the machine:

- assignment works
- events fire
- connector maps
- analysis runs
- qualitative UX issues surface

It cannot validate the business hypothesis.

`growth analyze --segment agent-generated` should make that explicit.

## 16. Example End-To-End Workflow

### 16.1 Initialize

```bash
growth init --json
growth status --json
```

### 16.2 Create Experiment

```bash
growth power-calc --baseline 0.2 --mde 0.2 --daily-traffic 500 --json
growth schema experiment --json
growth experiment create demand-driven-onboarding --from-json '<experiment json>' --json
```

### 16.3 Plan Instrumentation

```bash
growth instrumentation plan demand-driven-onboarding --json
```

The outer coding agent edits app code to:

- assign variants
- persist assignment
- emit required events
- include `experiment_id`
- include `variant_id`
- include `user_id`
- include `session_id`
- include `agent_generated`
- include `agent_run_id`

Then:

```bash
growth instrumentation verify demand-driven-onboarding --json
```

### 16.4 Configure PostHog

```bash
growth connector add posthog --json
growth connector auth check posthog --json
growth connector validate posthog --json
```

### 16.5 Prepare Preflight

```bash
growth preflight prepare demand-driven-onboarding --agents 4 --browser --json
```

The outer agent launches the prepared packets using the available runner.

### 16.6 Complete Preflight And Pull Events

```bash
growth preflight complete preflight_20260511T120000Z --json
growth preflight pull preflight_20260511T120000Z --source posthog --json
growth preflight audit preflight_20260511T120000Z --json
```

### 16.7 Analyze

```bash
growth analyze demand-driven-onboarding --segment agent-generated --json
growth preflight audit preflight_20260511T120000Z --markdown
```

Expected recommendation for synthetic-only data:

```text
Instrumentation valid, app flow exercised, synthetic-only no-ship.
```

### 16.8 Production Run

```bash
growth experiment start demand-driven-onboarding --json
growth pull demand-driven-onboarding --source posthog --after 2026-04-30T00:00:00Z --json
growth analyze demand-driven-onboarding --segment real-users --json
```

## 17. MVP

MVP should start from `every-exp` and add the missing control-plane hardening.

### 17.1 Must Have

- `growth init`
- managed `.growth` state
- standardized JSON envelope
- `growth status --json`
- strict experiment schema
- experiment create/list/show/start/stop
- power calculation
- PostHog connector
- connector validation
- PostHog auth preflight
- idempotent pull
- analysis recommendations
- agent skill scaffold
- `growth llm-context --json`
- instrumentation plan
- preflight prepare
- audit log

### 17.2 Should Have

- Segment connector
- Stripe connector
- native-app connector
- MCP server
- instrumentation verify
- generated browser-agent report schema
- run report markdown
- event taxonomy validation
- overlapping pull detection

### 17.3 Later

- direct `--backend claude-code`
- direct `--backend codex`
- TUI
- dashboard
- Slack notifications
- auto-stop daemon
- warehouse replay
- Bayesian or sequential testing
- multi-experiment interaction checks
- identity stitching
- signed onboarding token helpers

## 18. Implementation Plan

### Phase 1: Control Plane Foundation

1. Create package and CLI.
2. Implement JSON envelope.
3. Implement `.growth` store.
4. Implement audit log.
5. Implement schemas.
6. Implement `init`, `status`, `schema`, `llm-context`.
7. Scaffold `.agents/skills/growth`.

### Phase 2: Experiment Core

1. Port `every-exp` experiment types.
2. Port schema validation.
3. Port deterministic assignment.
4. Port sample-size calculation.
5. Port analysis engine.
6. Add conservative synthetic-only recommendation.

### Phase 3: Connectors And Pulls

1. Port connector mapper.
2. Add idempotency.
3. Add PostHog pull.
4. Add auth preflight and scope errors.
5. Add pull record state.
6. Add overlapping-window warnings.

### Phase 4: Instrumentation Planning

1. Add framework detection.
2. Add Next.js instrumentation planner.
3. Add event contract generation.
4. Add static verification stubs.
5. Add sample event verification.

### Phase 5: Preflight Prepare

1. Define run model.
2. Generate agent packets.
3. Generate report schemas.
4. Generate launch manual.
5. Add report attachment.
6. Add preflight pull by run event window.
7. Add preflight audit report.

### Phase 6: MCP

1. Mirror CLI tools.
2. Add resources for schemas and conventions.
3. Ensure every response is structured JSON.

### Phase 7: Optional Agent Launch Backends

1. Add manual backend.
2. Add dry-run backend.
3. Add Claude Code backend.
4. Add Codex backend if useful.
5. Keep backend packets compatible with existing run state.

## 19. Open Questions

1. Should experiment configs live under `.growth/experiments` by default, or a public `experiments/` directory?
2. Should `growth` include a local event ingestion server in MVP, or only pull from PostHog?
3. How much framework-specific instrumentation verification is realistic without becoming PostHog Wizard?
4. Should `growth connector add posthog` create PostHog insights/dashboards, or only configure event pull?
5. Should the first launch backend be `manual` only?
6. Should preflight runs support forced variants, or should forced variants be considered a special test mode?
7. How should `growth` model identity stitching across anonymous and logged-in events?
8. Should event taxonomy be global per repo or per experiment?
9. Should `growth` integrate with existing experimentation platforms, or remain independent?
10. What is the minimum credible production analysis method before adding sequential/Bayesian testing?

## 20. Strong Opinions

1. `growth` should be the product, not Runbook.
2. Runbook should remain an internal substrate until multiple vertical tools prove the abstraction.
3. `growth` should not pretend to be a coding agent.
4. `growth` should prepare agent packets before it launches agents.
5. `growth` should treat browser-agent preflights as first-class but synthetic.
6. `growth` should never recommend shipping based only on synthetic traffic.
7. `growth` should use JSON envelopes everywhere from day one.
8. `growth` should make `status --json` the first command in every agent workflow.
9. `growth` should own pull idempotency before real usage.
10. `growth` should use skills as guidance, not as the only source of truth.

## 21. One-Line Product Definition

`growth` is Stripe Projects for growth experiments, with a PostHog Wizard-style agent harness available when product behavior has to be instrumented or exercised.
