# Outerloop Harnesses

This directory contains the automation used to test `growth` against apps that
were not built around `growth`.

There are two harnesses:

- `dogfood-local.mjs`: fast, deterministic fixture loop with no external
  providers.
- `run.mjs`: full agent loop that asks one agent to build an ordinary SaaS app
  and another agent to roll out `growth` with Stripe Projects, PostHog, and
  browser preflight.

Generated run directories live under `outerloop/runs/`. That directory is
intentionally ignored except for `.gitignore`; run artifacts can include local
apps, traces, env-bearing provider state, and large generated files. Do not
commit run directories, and do not read or paste raw `.env` or vault files when
summarizing a run.

## Local Dogfood

Run the fixture harness from the repo root:

```sh
npm run dogfood:local
```

Useful direct invocations:

```sh
node outerloop/dogfood-local.mjs --iterations 1
node outerloop/dogfood-local.mjs --fixture onboarding-saas --iterations 1
node outerloop/dogfood-local.mjs --runs-dir outerloop/runs/local-dogfood-manual
```

The harness copies each fixture app from `examples/fixtures/`, initializes
`growth`, creates an experiment from the fixture spec, verifies instrumentation
against local JSONL events, prepares balanced preflight packets, attaches
synthetic reports, pulls local events, and audits the run.

Each fixture iteration writes:

- `commands.json`: compact record of every `growth` command, status, and `_next`
  command.
- `artifacts/inspection.json`: lightweight app inspection used before choosing
  the experiment.
- `artifacts/experiment-spec.json`: the exact experiment spec passed to
  `growth experiment create`.
- `artifacts/checklist.json`: assertions the harness used to decide pass/fail.
- `artifacts/agent-*.report.json`: synthetic agent reports attached to the
  preflight run.
- `traces/*.stdout.json`: full JSON envelopes for each command.
- `app/.growth/`: the generated product-repo state for that iteration.

Start with `summary.json`, then inspect a failing iteration's `commands.json`,
`artifacts/checklist.json`, and final `traces/*preflight-audit*.stdout.json`.

The current latest local run,
`outerloop/runs/local-dogfood-20260506T160500Z`, passed four iterations:
`onboarding-saas` and `pricing-saas`, two times each. Each iteration ran 18
`growth` commands and ended with `ready_for_posthog_preflight`.

That recommendation is intentional: local synthetic traffic can prove
instrumentation shape, event windows, report attachment, variant reachability,
and UX coverage. It is not provider-backed real-user readiness. The next step is
configuring or importing a provider connector, then running provider-backed
preflight and analysis.

## Full Agent Loop

`run.mjs` is the slower harness for real agent behavior:

```sh
node outerloop/run.mjs --help
node outerloop/run.mjs --id <run_id>
node outerloop/run.mjs --id <run_id> --phase builder-only
node outerloop/run.mjs --id <run_id> --phase rollout-only
node outerloop/run.mjs --id <run_id> --phase evaluate-only
```

`builder-only` stops after app generation and writes provider setup
instructions. Use `rollout-only` after that setup has been completed for the
same run id. Use `evaluate-only` when rollout artifacts already exist and you
only want to regenerate `evaluation.json`.

It requires these CLIs on `PATH`:

- `codex`
- `claude`
- `agent-browser`
- `stripe`

The full loop writes:

- `run.json`: run id, created time, app path, and command names.
- `prompts/builder.md`: prompt used to build the vanilla SaaS app.
- `prompts/rollout.md`: prompt used to ask a separate agent to roll out
  `growth`.
- `traces/builder-events.jsonl` and `traces/rollout-events.jsonl`: agent event
  streams.
- `traces/*stderr.log`: command errors and agent stderr.
- `artifacts/baseline-manifest.json`: app file manifest before `growth`.
- `artifacts/after-manifest.json`: app file manifest after rollout.
- `artifacts/rollout-session.json`: resume information when available.
- `evaluation.json`: deterministic checks over the run.
- `app/.growth/`: the product-repo state created by the rollout.

Use `evaluation.json` as the entry point. It checks that the builder produced an
app, the baseline did not already contain `growth` or Stripe Projects state, the
rollout invoked the expected tools, `growth` state exists, a PostHog connector
was configured, an experiment and preflight runs exist, audits were written, the
final audit reached provider-backed readiness, and known secret names did not
leak into collected artifacts.

Observed full-run artifacts currently show:

- `first-real-run`: passed. It includes two preflight audits; an earlier run was
  `do_not_launch`, and a later run reached `ready_for_real_users`.
- `clean-real-run`: passed. It includes three preflight audits that moved from
  `fix_instrumentation` to `do_not_launch` to `ready_for_real_users`.
- `neutral-growth-refactor`: contains builder and rollout artifacts but no
  `evaluation.json`; treat it as prompt and harness development evidence, not as
  a pass/fail run.

## What To Look For

When reading a run, separate three questions:

1. Did the agent follow the control plane?
   Look at `commands.json` or `rollout-events.jsonl` for `growth status`,
   schema inspection, experiment creation, instrumentation planning,
   verification, preflight preparation, report attachment, pull, and audit.

2. Did the generated state prove the right thing?
   Inspect `.growth/experiments`, `.growth/connectors`, `.growth/runs/*/run.json`,
   `.growth/runs/*/agent-packets`, `.growth/runs/*/reports`, pull records, and
   `audit.md`.

3. Did the recommendation mean what the demo claims?
   `ready_for_posthog_preflight` means local synthetic evidence passed and the
   next step is provider-backed validation. `ready_for_real_users` should require
   provider-backed evidence. `fix_instrumentation` and `do_not_launch` are useful
   failures; they show the loop found something actionable.

For product work, prefer failures where `_next` was missing, misleading, or too
provider-specific. Those are usually better `growth` improvements than changing
the harness.
