Use `growth` as the experiment control plane. Assume `growth` is available on
`PATH`.

Run `growth status --json`. If needed, initialize Growth. Then follow
`growth llm-context --json` and the next commands Growth gives you.

Create and implement an onboarding experiment using the existing Aptny
`/onboarding` flow.

Experiment intent:

Test whether a clearer, more guided onboarding treatment increases completed
renter profiles.

Expected shape:

- id: `onboarding-profile-completion`
- primary metric: `onboarding_completed / onboarding_started`
- guardrail: onboarding failure/error event
- variants: current onboarding as control, guided onboarding copy or structure
  as treatment

Use existing analytics and app conventions.

Report changed files, commands run, verification results, and the preflight or
blocker id.
