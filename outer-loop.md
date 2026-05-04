# Outer Loop

`growth` should be developed by repeatedly pointing it at ordinary product repos
that do not know `growth` exists.

The goal is not to make a perfect demo app. The goal is to find out whether
`growth` can survive contact with normal codebases, normal agent behavior, and
normal local development messiness.

## Core Loop

1. Scaffold or select a vanilla app repo.
   - No `growth` references.
   - No prebuilt experiment framework.
   - No agent-specific instrumentation.
   - Prefer realistic product flows over contrived examples.

2. Give another coding agent a `growth` rollout brief.
   - The agent should use `growth` as the control plane.
   - The agent may edit the app.
   - The agent should not hand-edit managed state.
   - The agent should document what it did and what was confusing.

3. Let the agent run the full workflow.
   - `growth init`
   - schema/catalog inspection
   - experiment creation
   - instrumentation planning
   - app code changes
   - verification
   - cohort preparation
   - optional browser-agent execution
   - report attachment
   - audit

4. Read both traces.
   - Human rollout trace, for intent and friction.
   - `.growth/` artifacts, for machine truth.

5. Revise `growth`.
   - Fix the places where the agent had to infer too much.
   - Remove artifacts that did not help.
   - Strengthen command outputs and next steps.
   - Repeat on a different vanilla repo.

## Why This Matters

`growth` is supposed to be sturdy enough to point at any repo. That means its
quality cannot be judged by a repo that was built with `growth` in mind.

The product only earns its keep if it can:

- discover enough about a real app to produce useful plans
- give agents strict but workable contracts
- create durable experiment state
- preserve safe boundaries around secrets and local state
- prepare repeatable browser-agent packets
- separate synthetic validation from real-user evidence
- leave behind audit artifacts that explain what happened

## What To Inspect After Each Run

### Human Trace

The rollout trace should answer:

- What experiment was attempted?
- What app behavior changed?
- Which `growth` commands were run?
- Which command outputs were useful?
- Which next steps were wrong or missing?
- Where did the agent guess?
- Where did the agent fight the CLI?
- What blocked real-user analysis?

### `.growth/` Artifacts

The generated state should answer:

- What is the exact experiment contract?
- What connector mappings exist?
- What cohort packets were prepared?
- Which browser sessions reported back?
- What event windows were used?
- What analysis or audit artifacts exist?
- Which files are source of truth, and which are redundant?

If a file in `.growth/` does not answer a question like this, it is a candidate
for removal, compaction, or conversion into CLI-only catalog data.

## Lessons From The Launchpad Run

The Launchpad run validated the outer loop.

What worked:

- A vanilla Next.js repo could be initialized.
- An agent created a real experiment.
- The app was instrumented after the fact.
- Endpoint verification passed.
- Cohort packets were prepared and used.
- Reports were attached and the run was completed.
- The human trace exposed concrete product gaps.

What did not work well enough:

- `instrumentation plan` ignored custom `experiment.instrumentation.events`.
- File suggestions assumed a `src/` layout.
- Local endpoint verification still required a PostHog connector for coverage.
- Cohort packet assignment was not variant-balanced.
- The generated cohort audit was too thin.
- `growth status` did not reflect local endpoint/browser events.
- The useful learning lived mostly in the manually written trace, not in the
  generated audit.

## Artifact Policy

`.growth/` is necessary, but it should be lean.

Keep:

- experiment configs
- connector configs that are actually used
- intentionally edited event taxonomy
- run records
- cohort packets
- attached reports
- pull records
- useful audit summaries
- append-only command audit

Question:

- default templates copied into every repo
- default taxonomy copied into every repo
- duplicate generated reports
- generic generated docs that are not read
- local state that does not affect behavior

Prefer keeping generic catalogs inside the CLI until the user customizes them.

## Skill Consumption

The loop should explicitly measure whether agents read generated guidance.

In the Launchpad run, the evidence shows:

- `growth init` generated skill files.
- `growth llm-context --json` was run.
- The rollout trace says the context command was useful.

But there is no direct evidence that the agent read
`.agents/skills/growth/SKILL.md` after initialization.

That matters. If generated skills are part of the product thesis, `growth`
should make their use visible or make them unnecessary.

Possible improvements:

- Make `growth init` next steps explicitly say `read .agents/skills/growth/SKILL.md`
  when the runtime will not auto-load skills.
- Add a `growth guidance --json` command that returns the same guidance without
  relying on skill mechanics.
- Include a `guidance_version` in `llm-context`.
- Add an optional trace field where agents can report which guidance source they
  used: skill, `llm-context`, AGENTS.md, or prompt-only.

## Near-Term Product Work

The next iterations should prioritize:

1. Make instrumentation planning include custom instrumentation events.
2. Improve framework/file detection for root `app/`, root `lib/`, and root
   `hooks/` Next.js layouts.
3. Add a first-class local/native connector for local endpoint or JSONL event
   ingestion.
4. Make endpoint verification optionally confirm app-emitted events from browser
   interactions, not just sample POST acceptance.
5. Add balanced cohort packet generation.
6. Make `cohort audit` summarize reports: variant distribution, completions,
   confusion, guardrail issues, and qualitative notes.
7. Make next steps auth-aware before recommending pulls.
8. Trim `.growth/` to durable state and useful artifacts only.

## Success Standard

The loop is working when each new vanilla repo produces:

- less guessing by the agent
- fewer manual workarounds
- clearer command outputs
- richer machine-readable artifacts
- a smaller and more useful `.growth/`
- better final audit summaries

When that happens across several unrelated app shapes, `growth` is becoming a
real control plane rather than a scripted demo.
