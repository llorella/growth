# Verification Harness

`verification/` is the active harness for testing Growth against real target
repositories. It replaces `outerloop/` for new work.

The harness keeps target repositories disposable:

- create a clean temporary git worktree
- copy explicitly configured env files into that worktree
- expose the current Growth CLI through `PATH`
- write a short agent prompt
- optionally launch an agent in the worktree
- collect the target repo diff, Growth state, run packets, and traces
- write a Growth usage audit for real agent sessions
- remove the worktree unless `--keep` is set

Run directories are ignored under `verification/runs/`.

Target configs may set `envFiles`, for example `[".env"]`. These files are
copied from the target repo into the disposable worktree before the agent starts
so local app servers can use the same runtime config. Artifact collection
excludes `.env` and `.env.*` files from status, untracked lists, and patches.

## Aptny

Prepare a clean Aptny verification worktree and prompt:

```sh
npm run verify:aptny
```

Launch with an agent command:

```sh
npm run verify:aptny -- --agent-command "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd {{WORKTREE}} -"
```

Keep the worktree after the run:

```sh
npm run verify:aptny -- --keep
```

After a run, inspect:

- `run.json`
- `artifacts/git-status.txt`
- `artifacts/git-diff.patch`
- `artifacts/growth/`
- `artifacts/growth-usage-audit.json`
- `traces/agent.stdout.log`
- `traces/agent.stderr.log`

The usage audit grades whether the agent stayed inside Growth's control plane
and flags escape hatches such as raw env reads, direct provider API probes, or
managed `.growth` state reads. `run.json` repeats the run-level summary as
`growth_usage_score`, `growth_usage_grade`, and count fields, with the full
details in `artifacts/growth-usage-audit.json`. The audit separates preflight
planning from a preflight run attempt, completion, or explicit blocker. It is a
diagnostic signal only. The reviewer still decides whether the target repo diff
is sound and whether the Growth artifacts support the product conclusion.

Runs where the agent is unavailable, for example a Codex usage-limit failure,
are classified as `agent_unavailable` and do not receive a Growth usage audit.
